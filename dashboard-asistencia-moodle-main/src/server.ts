import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import { connectDB } from './db';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`📡 [${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

console.log("✅ [ANTIGRAVITY-1.1] SISTEMA DE RUTAS PREPARADO");

const PORT = process.env.PORT || 3000;
const MOODLE_URL = process.env.MOODLE_URL;
const MOODLE_TOKEN = process.env.MOODLE_TOKEN;
const MINUTOS_OBJETIVO_DIARIO = 170;

// Helpers globales
const cleanMoodleResponse = (data: any) => {
  if (typeof data === 'string' && (data.includes('{') || data.includes('['))) {
    try {
      const firstBrace = data.indexOf('{');
      const firstBracket = data.indexOf('[');
      const start = (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) ? firstBrace : firstBracket;
      if (start !== -1) {
        return JSON.parse(data.substring(start));
      }
    } catch (e) {
      console.error("Error limpiando respuesta Moodle:", e);
    }
  }
  return data;
};

type AttendanceScheduleDay = {
  day: string;       // Ej: 'Lunes', 'Martes', 'Sábado'
  startTime: string; // 'HH:MM'
  endTime: string;   // 'HH:MM'
};

type AttendanceSettingsDoc = {
  _id?: any;
  courseId: string;
  groupId: string;
  groupName?: string;
  startDate?: Date;
  endDate?: Date;
  scheduleTime?: string;
  holidays?: string[];
  minMinutesPerDay: number;
  globalAttendancePercent: number;
  schedule: AttendanceScheduleDay[];
  createdAt?: Date;
  updatedAt?: Date;
};

type RegisteredCourseDoc = {
  courseId?: number;
  shortname?: string;
  fullname?: string;
  moodleUrl?: string;
  moodleToken?: string;
  [key: string]: any;
};

type MoodleAccessConfig = {
  moodleUrl: string;
  moodleToken: string;
  wsUrl: string;
  source: 'course' | 'global';
  courseConfig: RegisteredCourseDoc | null;
};

const normalizeCourseRef = (value: any): string => String(value ?? '').trim();

const buildMoodleWsUrl = (moodleUrl: string): string => {
  const cleanBase = String(moodleUrl || '').replace(/\/+$/, '');
  return `${cleanBase}/webservice/rest/server.php`;
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findRegisteredCourse = async (db: any, courseRefRaw: any): Promise<RegisteredCourseDoc | null> => {
  const courseRef = normalizeCourseRef(courseRefRaw);
  if (!courseRef) return null;

  const coursesCol = db.collection('registeredCourses');
  let courseConfig: RegisteredCourseDoc | null = null;

  const numericCourseId = Number(courseRef);
  if (!Number.isNaN(numericCourseId)) {
    courseConfig = await coursesCol.findOne({ courseId: numericCourseId });
  }

  if (!courseConfig) {
    courseConfig = await coursesCol.findOne({ shortname: courseRef });
  }

  if (!courseConfig) {
    courseConfig = await coursesCol.findOne({
      shortname: { $regex: `^${escapeRegex(courseRef)}$`, $options: 'i' },
    });
  }

  return courseConfig;
};

const getMoodleAccessConfig = async (
  db: any,
  courseRefRaw: any,
  options: { allowGlobalFallback?: boolean } = {},
): Promise<MoodleAccessConfig> => {
  const allowGlobalFallback = options.allowGlobalFallback ?? true;
  const courseRef = normalizeCourseRef(courseRefRaw);
  const courseConfig = await findRegisteredCourse(db, courseRef);

  const courseMoodleUrl = normalizeCourseRef(courseConfig?.moodleUrl);
  const courseMoodleToken = normalizeCourseRef(courseConfig?.moodleToken);

  if (courseMoodleUrl && courseMoodleToken) {
    return {
      moodleUrl: courseMoodleUrl,
      moodleToken: courseMoodleToken,
      wsUrl: buildMoodleWsUrl(courseMoodleUrl),
      source: 'course',
      courseConfig,
    };
  }

  if (allowGlobalFallback && MOODLE_URL && MOODLE_TOKEN) {
    return {
      moodleUrl: MOODLE_URL,
      moodleToken: MOODLE_TOKEN,
      wsUrl: buildMoodleWsUrl(MOODLE_URL),
      source: 'global',
      courseConfig,
    };
  }

  const hint = courseRef ? ` para el curso "${courseRef}"` : '';
  throw new Error(`No hay configuración de Moodle válida${hint}.`);
};

app.get('/api/curso/:id', async (req: any, res: any) => {
  try {
    const courseId = req.params.id;
    console.log(`Buscando curso ID: ${courseId}...`);
    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, courseId);

    const response = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_course_get_courses',
        moodlewsrestformat: 'json',
        'options[ids][0]': courseId
      }
    });

    console.log('Respuesta de Moodle:', response.data);
    res.json(response.data);
  } catch (error: any) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Error conectando a Moodle' });
  }
});

// Ruta Reporte 18 
app.get('/api/stats/:courseId', async (req: any, res: any) => {
  try {

    const courseIdParam = req.params.courseId;
    const userEmail = (req.query.userId || req.query.userid || '').toString().trim();
    const courseShortname = (req.query.courseShortname || courseIdParam || '').toString().trim();
    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, courseIdParam, { allowGlobalFallback: false });

    console.log(`🕵🏻‍♀️ Buscando: Usuario="${userEmail}" en Curso="${courseShortname}"...`);

    const moodleResponse = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_reportbuilder_retrieve_report',
        moodlewsrestformat: 'json',
        reportid: 12,
        perpage: 10000,
      }
    });

    const raw = moodleResponse.data;
    const rows = raw.data?.rows || [];

    console.log(`📊 Moodle respondió con ${raw.data?.totalrowcount || 0} filas.`);

    const usernameIdx = 0;
    const courseShortIdx = 1;
    const dateIdx = 2;
    const durationIdx = -1; // No hay duración en el reporte 12

    const parseDuration = (text: string): number => {
      if (!text) return 0;
      const s = text.toLowerCase();
      let total = 0;
      const hMatch = s.match(/(\d+)\s*hora/);
      const mMatch = s.match(/(\d+)\s*minuto/);
      if (hMatch) total += parseInt(hMatch[1]) * 60;
      if (mMatch) total += parseInt(mMatch[1]);
      return total;
    };

    // --- HELPER 2: Parsear Fecha Español (jueves, 9 de mayo de 2024, 09:22) ---
    const parseSpanishDate = (dateStr: string): number => {
      if (!dateStr) return 0;
      const meses: { [key: string]: number } = {
        'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
        'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11,
        'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
        'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
      };
      try {
        const cleanStr = dateStr.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

        let match = cleanStr.match(/(\d{1,2}) de ([a-zñ]+) de (\d{4}) (\d{1,2}):(\d{2})/);
        if (!match) match = cleanStr.match(/(\d{1,2}) ([a-z]+) (\d{4}) (\d{1,2}):(\d{2})/);

        if (match) {
          const dia = parseInt(match[1]);
          const mesNombre = match[2];
          const anio = parseInt(match[3]);
          const horaRaw = parseInt(match[4]);
          const min = parseInt(match[5]);
          let hora = horaRaw;
          if (cleanStr.includes('pm') && hora < 12) hora += 12;
          if (cleanStr.includes('am') && hora === 12) hora = 0;

          return new Date(anio, meses[mesNombre] ?? 0, dia, hora, min).getTime();
        } else {
          const regexSimple = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
          const matchS = cleanStr.match(regexSimple);
          if (matchS) return new Date(parseInt(matchS[3]), parseInt(matchS[2]) - 1, parseInt(matchS[1])).getTime();
        }
      } catch (e) { console.warn('Error fecha:', dateStr); }
      return 0;
    };

    let minutosTotales = 0;
    let entradasEncontradas = 0;
    let ultimoAccesoUnix = 0;

    for (const row of rows) {
      const columnas = row.columns;

      const rowUser = String(columnas[usernameIdx] ?? '').toLowerCase();
      const rowCourse = String(columnas[courseShortIdx] ?? '');

      // Match
      const userMatch = rowUser.includes(userEmail.toLowerCase());
      const courseMatch = courseShortname ? (rowCourse === courseShortname) : true;

      if (userMatch && courseMatch) {
        const duracionTexto = durationIdx !== -1 ? columnas[durationIdx] : '';
        const minutosFila = parseDuration(duracionTexto);
        minutosTotales += minutosFila;
        entradasEncontradas++;

        const fechaTexto = String(columnas[dateIdx] ?? '');
        const timestampFila = parseSpanishDate(fechaTexto);

        if (timestampFila > ultimoAccesoUnix) {
          ultimoAccesoUnix = timestampFila;
        }

        console.log(`➕ Fila: ${minutosFila} min - Fecha: ${fechaTexto}`);
      }
    }

    // Calcular Totales Texto
    const horasReales = Math.floor(minutosTotales / 60);
    const minsReales = minutosTotales % 60;
    const tiempoTexto = `${horasReales} horas ${minsReales} minutos`;

    let horaEntradaStr: string | number = 0;
    let horaSalidaStr: string | number = 0;

    if (ultimoAccesoUnix > 0) {
      const fmt12 = (ms: number): string => {
        const d = new Date(ms);
        const h = d.getHours();
        const m = d.getMinutes();
        const h12 = ((h % 12) || 12).toString().padStart(2, '0');
        const mm = m.toString().padStart(2, '0');
        const ampm = h < 12 ? 'AM' : 'PM';
        return `${h12}:${mm} ${ampm}`;
      };

      const salidaMs = ultimoAccesoUnix;
      const entradaMs = salidaMs - (minutosTotales * 60000);

      horaSalidaStr = fmt12(salidaMs);
      horaEntradaStr = fmt12(entradaMs);
      console.log(`🕒 Calculado desde logs -> Salida: ${horaSalidaStr}, Entrada: ${horaEntradaStr}`);
    } else {
      console.warn('⚠️ No se encontraron fechas válidas en los logs para calcular horas.');
    }

    const collection = db.collection('asistencia');

    const doc = {
      courseId: courseIdParam,
      userId: userEmail,
      courseShortname,
      fechaConsulta: new Date(),
      tiempoTexto,
      minutosTotales,
      entradasSumadas: entradasEncontradas,
      horaEntrada: horaEntradaStr,
      horaSalida: horaSalidaStr,
    };

    const resultadoMongo = await collection.insertOne(doc);
    console.log('🍃 Guardado en Mongo:', resultadoMongo.insertedId);

    res.json({
      ok: true,
      asistencia: {
        courseId: courseIdParam,
        userId: userEmail,
        horaEntrada: horaEntradaStr,
        horaSalida: horaSalidaStr,
        minutosTotales,
        tiempoTexto: tiempoTexto,
        entradasEncontradas
      }
    });

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: 'Error procesando reporte' });
  }
});

//Daily stats agrupado por estudiante
app.get('/api/dailystats/:courseId', async (req: any, res: any) => {
  console.log(" ⚠️ ALERTA ⚠️ ", req.params.courseId?.toString().trim());

  try {
    const courseId = req.params.courseId?.toString().trim();
    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, courseId, { allowGlobalFallback: false });
    const courseConfig = moodleConfig.courseConfig;
    const normalizedCourseId = String(courseConfig?.courseId ?? courseId ?? '').trim();
    const courseShortname = (
      req.query.courseShortname ||
      courseConfig?.shortname ||
      courseId ||
      ''
    ).toString().trim();

    if (!normalizedCourseId) {
      return res.status(400).json({ error: 'courseId es requerido.' });
    }

    // Si no hay horario definido, usamos un default amplio (ej: 00:00 - 23:59)
    const horarioCurso = courseConfig?.scheduleTime || "00:00 - 23:59";
    console.log(`🕒 Aplicando horario de corte: ${horarioCurso}`);

    let moodleCourseId: any = courseConfig?.courseId ?? normalizedCourseId;

    // Validación de ID numérico...
    if (isNaN(Number(moodleCourseId))) {
      try {
        const allCoursesResp = await axios.get(moodleConfig.wsUrl, {
          params: { wstoken: moodleConfig.moodleToken, wsfunction: 'core_course_get_courses', moodlewsrestformat: 'json' }
        });
        const allCourses = Array.isArray(allCoursesResp.data) ? allCoursesResp.data : [];
        const match = allCourses.find((c: any) => c.shortname === courseId || c.shortname === normalizedCourseId);
        if (match) moodleCourseId = match.id;
      } catch (e) { console.error("Error cursos:", e); }
    }

    // Obtener usuarios matriculados
    const enrolledResp = await axios.get(moodleConfig.wsUrl, {
      params: { wstoken: moodleConfig.moodleToken, wsfunction: 'core_enrol_get_enrolled_users', moodlewsrestformat: 'json', courseid: moodleCourseId }
    });
    const enrolledList: any[] = Array.isArray(enrolledResp.data) ? enrolledResp.data : [];

    const groupsByUsername = new Map<string, string>();
    const userIdToUsername = new Map<number, string>();
    const fullNameByUsername = new Map<string, string>();
    const userAliasToUsername = new Map<string, string>();
    const normalizeUserKey = (value: any): string => String(value ?? '').trim().toLowerCase();

    // Mapeo de grupos...
    for (const u of enrolledList) {
      const uname = normalizeUserKey(u?.username);
      const fullName = String(
        u?.fullname ??
        `${String(u?.firstname ?? '').trim()} ${String(u?.lastname ?? '').trim()}`.trim()
      ).trim();
      const emailKey = normalizeUserKey(u?.email);
      if (u.id && uname) userIdToUsername.set(u.id, uname);
      let gname = 'Sin Grupo';
      const gs = Array.isArray(u?.groups) ? u.groups : [];
      if (gs.length > 0) gname = String(gs[0]?.name ?? 'Sin Grupo');
      if (uname) {
        groupsByUsername.set(uname, gname);
        fullNameByUsername.set(uname, fullName || uname);
        userAliasToUsername.set(uname, uname);
        if (fullName) userAliasToUsername.set(normalizeUserKey(fullName), uname);
        if (emailKey) userAliasToUsername.set(emailKey, uname);
      }
    }

    // Obtener grupos profundos
    try {
      const groupsResp = await axios.get(moodleConfig.wsUrl, {
        params: { wstoken: moodleConfig.moodleToken, wsfunction: 'core_group_get_course_groups', moodlewsrestformat: 'json', courseid: moodleCourseId }
      });
      const courseGroups = Array.isArray(groupsResp.data) ? groupsResp.data : [];
      for (const grp of courseGroups) {
        const membersResp = await axios.get(moodleConfig.wsUrl, {
          params: { wstoken: moodleConfig.moodleToken, wsfunction: 'core_group_get_group_members', moodlewsrestformat: 'json', 'groupids[0]': grp.id }
        });
        const members = Array.isArray(membersResp.data) ? membersResp.data : [];
        for (const m of members) {
          const uname = userIdToUsername.get(m.userid);
          if (uname) groupsByUsername.set(uname, grp.name);
        }
      }
    } catch (errGroup) { console.warn("Warn grupos:", errGroup); }

    // Obtener Reporte de Logs
    const moodleRaw = await axios.post(moodleConfig.wsUrl, null, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_reportbuilder_retrieve_report',
        moodlewsrestformat: 'json',
        reportid: 12,
        perpage: 100
      }
    });

    // Limpiar respuesta por si Moodle mandó basura debug de PHP
    const reportData = (typeof moodleRaw.data === 'string') ? cleanMoodleResponse(moodleRaw.data) : moodleRaw.data;
    const rows: any[] = reportData?.data?.rows || reportData?.rows || [];

    // Estructuras
    type DayItem = { fecha: string; minutos: number; firstTs: number; lastTs: number; entrada?: string; salida?: string; };
    type UserAgg = { usuario: string; nombre: string; groupName: string; minutosTotales: number; diasDetalle: DayItem[] };
    const byUser = new Map<string, UserAgg>();

    // Inicializar usuarios
    groupsByUsername.forEach((groupName, username) => {
      byUser.set(username, {
        usuario: username,
        nombre: fullNameByUsername.get(username) || username,
        groupName: groupName,
        minutosTotales: 0,
        diasDetalle: []
      });
    });

    const usernameIdx = 0;
    const courseShortIdx = 1;
    const durationIdx = -1;
    const dateIdx = 2;
    const courseShortnameVal = (req.query.courseShortname || courseConfig?.shortname || courseId || '').toString().trim();

    // Nombres del curso de la DB para mejorar el match
    const dbCourseShortname = courseConfig?.shortname?.toLowerCase() || '';
    const dbCourseFullname = courseConfig?.fullname?.toLowerCase() || '';

    // Helpers locales 
    const stripTags = (s: any) => (typeof s === 'string' ? s.replace(/<[^>]*>/g, '') : s);
    const toText = (cell: any) => {
      if (cell == null) return '';
      if (typeof cell === 'string') return stripTags(cell);
      if (typeof cell === 'object') return stripTags(cell.displayvalue ?? cell.value ?? '');
      return '';
    };
    const parseDuration = (text: string) => {
      if (!text) return 0;
      const s = text.toLowerCase().replace(/<[^>]*>/g, '').trim();
      const hm = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (hm) return (parseInt(hm[1], 10) || 0) * 60 + (parseInt(hm[2], 10) || 0);
      const hMatch = s.match(/(\d+)\s*(?:h|hora|horas)/);
      const mMatch = s.match(/(\d+)\s*(?:m|min|minuto|minutos|mins|minute|minutes)/);
      let total = 0;
      if (hMatch) total += parseInt(hMatch[1], 10) * 60;
      if (mMatch) total += parseInt(mMatch[1], 10);
      return total > 0 ? total : 0;
    };
    const parseSpanishDate = (dateStr: string): number => {
      if (!dateStr) return 0;
      const meses: { [key: string]: number } = {
        'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5, 'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11,
        'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
        'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
      };
      try {
        const cleanStr = dateStr.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

        let match = cleanStr.match(/(\d{1,2}) de ([a-zñ]+) de (\d{4}) (\d{1,2}):(\d{2})/);
        if (!match) match = cleanStr.match(/(\d{1,2}) ([a-z]+) (\d{4}) (\d{1,2}):(\d{2})/);

        if (match) {
          const dia = parseInt(match[1]);
          const mesNombre = match[2];
          const anio = parseInt(match[3]);
          const horaRaw = parseInt(match[4]);
          const min = parseInt(match[5]);
          let hora = horaRaw;
          if (cleanStr.includes('pm') && hora < 12) hora += 12;
          if (cleanStr.includes('am') && hora === 12) hora = 0;

          return new Date(anio, meses[mesNombre] ?? 0, dia, hora, min).getTime();
        }
      } catch (e) { }
      return 0;
    };

    for (const row of rows) {
      const cells = row.columns || [];
      const user = toText(cells[usernameIdx]).trim();
      const courseVal = toText(cells[courseShortIdx]).trim();
      // durationIdx is -1 for report 12, so skip duration
      const durText = durationIdx >= 0 ? toText(cells[durationIdx]) : '';

      const normMoodle = courseVal.toLowerCase();
      const normFront = courseShortnameVal.toLowerCase();

      // Course matching: flexible comparison
      const isMatch = normMoodle === normFront ||
        normMoodle.includes(normFront) ||
        normFront.includes(normMoodle) ||
        (dbCourseShortname && normMoodle.includes(dbCourseShortname)) ||
        (dbCourseFullname && normMoodle.includes(dbCourseFullname)) ||
        normMoodle.endsWith(' ' + normFront);

      if (!isMatch) {
        if (rows.indexOf(row) < 3) console.log(`DEBUG: Course mismatch - Moodle: "${normMoodle}", Target: "${normFront}"`);
        continue;
      }
      if (!user) continue;

      const rawUserKey = normalizeUserKey(user);
      const userKey = userAliasToUsername.get(rawUserKey) || rawUserKey;
      if (!byUser.has(userKey)) {
        if (rows.indexOf(row) < 5) console.log(`DEBUG: User not in enrolled list: raw="${rawUserKey}" resolved="${userKey}"`);
        continue;
      }

      console.log(`DEBUG: Processing row for user "${rawUserKey}" as "${userKey}" course "${courseVal}"`);
      const agg = byUser.get(userKey)!;

      // Parse last access date (Col 2) - English format with AM/PM
      const dateTextRaw = toText(cells[dateIdx]);
      if (!dateTextRaw || dateTextRaw.toLowerCase() === 'never' || dateTextRaw.toLowerCase() === 'nunca') {
        console.log(`DEBUG: User "${userKey}" has no access date (Never)`);
        continue;
      }

      const startTimestamp = parseSpanishDate(dateTextRaw);

      if (startTimestamp > 0) {
        // If we have duration data, use it; otherwise estimate based on schedule
        let sessionMinutes = parseDuration(durText);
        if (sessionMinutes === 0 && durationIdx < 0) {
          // No duration column available - estimate a default session
          // Parse the schedule to get the max daily minutes
          const parts = horarioCurso.split('-').map((p: string) => p.trim());
          if (parts.length === 2) {
            const [sh, sm] = parts[0].split(':').map(Number);
            const [eh, em] = parts[1].split(':').map(Number);
            const scheduleMinutes = (eh * 60 + em) - (sh * 60 + sm);
            // Use the configured daily objective or schedule as estimate
            sessionMinutes = Math.min(scheduleMinutes > 0 ? scheduleMinutes : MINUTOS_OBJETIVO_DIARIO, MINUTOS_OBJETIVO_DIARIO);
          } else {
            sessionMinutes = MINUTOS_OBJETIVO_DIARIO;
          }
        }

        const endTimestamp = startTimestamp + (sessionMinutes * 60 * 1000);
        const d = new Date(startTimestamp);
        const fecha = d.toISOString().split('T')[0];

        // Find or create day entry
        const idx = agg.diasDetalle.findIndex((d) => d.fecha === fecha);

        if (idx >= 0) {
          if (startTimestamp < agg.diasDetalle[idx].firstTs) agg.diasDetalle[idx].firstTs = startTimestamp;
          if (endTimestamp > agg.diasDetalle[idx].lastTs) agg.diasDetalle[idx].lastTs = endTimestamp;
        } else {
          agg.diasDetalle.push({
            fecha,
            minutos: 0,
            firstTs: startTimestamp,
            lastTs: endTimestamp
          });
        }
      }
    }

    byUser.forEach((userAgg) => {
      let totalUsuario = 0;

      userAgg.diasDetalle.forEach((dia) => {
        const fechaEntrada = new Date(dia.firstTs);
        const fechaSalida = new Date(dia.lastTs);

        const minutosReales = calcularMinutosEnHorario(fechaEntrada, fechaSalida, horarioCurso);

        dia.minutos = minutosReales;

        totalUsuario += minutosReales;
      });

      userAgg.minutosTotales = totalUsuario;
    });

    const out = Array.from(byUser.values());
    const collection = db.collection('asistencia');

    if (out.length > 0) {
      // No borrar si son datos de demo/manuales protegidos
      await collection.deleteMany({ courseId: normalizedCourseId, isDemo: { $ne: true } });
      const docsToInsert = out.map(item => ({
        ...item,
        courseId: normalizedCourseId,
        courseShortname: courseShortnameVal || normalizedCourseId,
        fechaProceso: new Date()
      }));
      await collection.insertMany(docsToInsert);
    }

    return res.json({ ok: true, mensaje: `Procesados ${out.length} usuarios con horario ${horarioCurso}`, data: out });

  } catch (err: any) {
    console.error('❌ Error en /api/dailystats:', err?.message || err);
    return res.status(500).json({ error: 'Error generando dailystats', detalle: String(err?.message || err) });
  }
});

const formatHours = (minutes: number) => {
  if (!minutes) return '0:00H';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const mStr = m.toString().padStart(2, '0');
  return `${h}:${mStr}H`;
};

const formatSimpleHours = (minutes: number) => {
  if (!minutes) return '0:00';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${m.toString().padStart(2, '0')}`;
};

// Export Semanal (Excel Oficial + Vista Previa JSON) - CON VALIDACIÓN DE FECHAS DE GRUPO
app.get('/api/reports/weekly-export', async (req: any, res: any) => {
  try {
    const { startDate, endDate, courseId, format, groupId, userQuery } = req.query;

    if (!startDate || !endDate || !courseId) return res.status(400).json({ error: 'Faltan parámetros' });

    const startStr = startDate.split('T')[0];
    const endStr = endDate.split('T')[0];
    const start = new Date(startStr + 'T12:00:00');
    const end = new Date(endStr + 'T12:00:00');

    const db = await connectDB();
    const col = db.collection('asistencia');
    const coursesCol = db.collection('registeredCourses');
    const settingsCol = db.collection('attendanceSettings');

    const courseInfo = await coursesCol.findOne({ courseId: Number(courseId) });
    const courseCode = courseInfo?.shortname || 'COD-001';
    const courseName = courseInfo?.fullname || 'CURSO SIN NOMBRE';
    const entidadNombre = courseInfo?.entityName || 'FORMACIÓN Y MANTENIMIENTO TÉCNICO S.A.';
    const entidadCif = courseInfo?.cif || 'A09326513';

    const defaultMin = Number(courseInfo?.minMinutes || 170);
    const defaultThreshold = Number(courseInfo?.globalThreshold || 80);
    const defaultTotalHours = courseInfo?.totalHours || '30H';
    const defaultSchedule = courseInfo?.scheduleTime || '09:00 - 14:00';
    const defaultStartDate = courseInfo?.startDate ? new Date(courseInfo.startDate) : null;
    const defaultEndDate = courseInfo?.endDate ? new Date(courseInfo.endDate) : null;

    const allSettings = await settingsCol.find({ courseId: String(courseId) }).toArray();
    let allUsersRaw = await col.find({ courseId: String(courseId) }).toArray();

    // --- CONSOLIDACIÓN DE DATOS POR USUARIO ---
    // Agrupamos documentos duplicados o fragmentados del mismo usuario
    const userMap = new Map<string, any>();
    allUsersRaw.forEach(u => {
      const key = String(u.usuario || u.userName || u.nombre || '').toLowerCase().trim();
      if (!key) return;
      if (!userMap.has(key)) {
        userMap.set(key, { ...u, diasDetalle: [...(u.diasDetalle || [])] });
      } else {
        const existing = userMap.get(key);
        // Mezclamos los días evitando duplicados de fecha
        const existingDates = new Set(existing.diasDetalle.map((d: any) => d.fecha));
        (u.diasDetalle || []).forEach((d: any) => {
          if (!existingDates.has(d.fecha)) {
            existing.diasDetalle.push(d);
            existingDates.add(d.fecha);
          }
        });
        // Sumamos minutos totales para coherencia interna
        existing.minutosTotales = (existing.minutosTotales || 0) + (u.minutosTotales || 0);
      }
    });

    let allUsers = Array.from(userMap.values());

    if (groupId && groupId !== 'todos') {
      const targetGroupSetting = allSettings.find(s => String(s.groupId) === String(groupId));
      if (targetGroupSetting) {
        const targetName = (targetGroupSetting.groupName || '').toLowerCase().trim();
        allUsers = allUsers.filter((u: any) => {
          const uGroup = (u.groupName || u.grupo || '').toLowerCase().trim();
          return uGroup === targetName;
        });
      }
    }

    if (userQuery) {
      const q = String(userQuery).toLowerCase().trim();
      allUsers = allUsers.filter((u: any) => {
        const nombre = (u.nombre || u.usuario || '').toLowerCase();
        return nombre.includes(q);
      });
    }

    const usersFiltered = allUsers;

    const getDayName = (d: Date) => ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][d.getDay()];
    const diasSemana: { fechaStr: string, diaNombre: string }[] = [];
    let loopDate = new Date(startStr + 'T12:00:00');
    const loopEnd = new Date(endStr + 'T12:00:00');

    while (loopDate <= loopEnd) {
      const dayIdx = loopDate.getDay();
      if (dayIdx >= 1 && dayIdx <= 5) {
        diasSemana.push({
          fechaStr: loopDate.toISOString().split('T')[0],
          diaNombre: getDayName(loopDate)
        });
      }
      loopDate.setDate(loopDate.getDate() + 1);
    }

    if (format === 'json') {
      const rowsData = usersFiltered.map((user: any) => {
        const gName = user.groupName || 'Sin Grupo';
        const rule = allSettings.find(s => s.groupName === gName) || {} as any;

        const objetivoDiario = Number(rule.minMinutesPerDay || defaultMin);
        const umbral = Number(rule.globalAttendancePercent || defaultThreshold);
        const feriadosGrupo = Array.isArray(rule.holidays) ? rule.holidays : [];

        const inicioG = rule.startDate ? new Date(rule.startDate) : defaultStartDate;
        const finG = rule.endDate ? new Date(rule.endDate) : defaultEndDate;
        if (inicioG) inicioG.setHours(0, 0, 0, 0);
        if (finG) finG.setHours(23, 59, 59, 999);

        const base: any = {
          nombre: user.nombre || user.usuario || 'Sin Nombre',
          grupo: gName,
          Lunes: 0, Martes: 0, Miércoles: 0, Jueves: 0, Viernes: 0,
          totalSemana: 0,
          estado: 'PENDIENTE',
          objetivo: objetivoDiario
        };

        let totalUserMinutes = 0;
        let diasHabilesUsuario = 0;

        diasSemana.forEach(d => {
          const currentD = new Date(d.fechaStr + 'T12:00:00');

          let fueraDeRango = false;
          if (inicioG && currentD < inicioG) fueraDeRango = true;
          if (finG && currentD > finG) fueraDeRango = true;

          const esFeriado = feriadosGrupo.includes(d.fechaStr);

          if (esFeriado || fueraDeRango) {
            base[d.diaNombre] = -1;
          } else {
            diasHabilesUsuario++;

            const det = user.diasDetalle?.find((x: any) => x.fecha === d.fechaStr);
            if (det) {
              const mins = det.minutos || 0;
              base[d.diaNombre] = mins;
              totalUserMinutes += mins;
            }
          }
        });

        const metaSemanal = diasHabilesUsuario * objetivoDiario;
        if (diasHabilesUsuario === 0) {
          base.estado = 'N/A';
        } else {
          const metaReal = metaSemanal * (umbral / 100);
          if (totalUserMinutes >= metaReal) base.estado = 'APTO';
          else base.estado = 'NO APTO';
        }

        return base;
      });

      return res.json({ ok: true, data: rowsData });
    }

    const wb = new ExcelJS.Workbook();

    const usersByGroup: { [key: string]: any[] } = {};
    usersFiltered.forEach((u: any) => {
      const gName = u.groupName || 'Sin Grupo';
      if (!usersByGroup[gName]) usersByGroup[gName] = [];
      usersByGroup[gName].push(u);
    });

    const drawHeader = (ws: ExcelJS.Worksheet, config: any) => {
      const logoPath = path.join(__dirname, 'assets', 'logo.png');
      if (fs.existsSync(logoPath)) {
        const logoId = wb.addImage({ filename: logoPath, extension: 'png' });
        ws.addImage(logoId, { tl: { col: 5, row: 0 }, ext: { width: 180, height: 60 } });
      }

      const fInicio = config.startDate ? new Date(config.startDate).toLocaleDateString('es-ES') : (defaultStartDate?.toLocaleDateString('es-ES') || '--');
      const fFin = config.endDate ? new Date(config.endDate).toLocaleDateString('es-ES') : (defaultEndDate?.toLocaleDateString('es-ES') || '--');
      const horario = config.scheduleTime || defaultSchedule;
      const totHoras = defaultTotalHours;

      ws.columns = [
        { key: 'dni', width: 15 }, { key: 'nombre', width: 40 },
        { key: 'lunes', width: 15 }, { key: 'martes', width: 15 },
        { key: 'miercoles', width: 15 }, { key: 'jueves', width: 15 }, { key: 'viernes', width: 15 },
      ];

      ws.mergeCells('A3:G3'); ws.getCell('A3').value = 'CONTROL DE ASISTENCIA SEMANAL';
      ws.getCell('A3').alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getCell('A3').font = { name: 'Arial', size: 14, bold: true, underline: true };

      const mes = start.toLocaleString('es-ES', { month: 'long' });
      ws.mergeCells('A4:G4'); ws.getCell('A4').value = `SEMANA DEL ${start.getDate()} al ${end.getDate()} de ${mes.toUpperCase()} de ${start.getFullYear()}`;
      ws.getCell('A4').alignment = { horizontal: 'center' };
      ws.getCell('A4').font = { name: 'Arial', size: 11, bold: true };

      ws.getCell('A6').value = `ENTIDAD DE FORMACIÓN: ${entidadNombre}`;
      ws.getCell('A7').value = `CENTRO DE FORMACIÓN: ${entidadNombre}`;
      ws.getCell('F6').value = `CIF ${entidadCif}`;
      ['A6', 'A7', 'F6'].forEach(c => ws.getCell(c).font = { size: 9, bold: true });

      ws.mergeCells('A9:G9'); ws.getCell('A9').value = `ESPECIALIDAD FORMATIVA: ${courseName.toUpperCase()}`;
      ws.getCell('A9').font = { size: 9, bold: true };

      ws.mergeCells('A10:B10'); ws.getCell('A10').value = `FECHA INICIO: ${fInicio}`;
      ws.mergeCells('C10:E10'); ws.getCell('C10').value = `FECHA FINAL PREVISTA: ${fFin}`;
      ws.getCell('F10').value = `HORAS: ${totHoras}`; ws.getCell('G10').value = `HORARIO: ${horario}`;
      ['A10', 'C10', 'F10', 'G10'].forEach(c => ws.getCell(c).font = { size: 8 });

      ws.mergeCells('A13:D13'); ws.getCell('A13').value = `${courseCode} ${courseName.toUpperCase()}`;
      ws.getCell('A13').font = { bold: true, underline: true, size: 10 };

      ws.getCell('A14').value = `FECHA INICIO: ${fInicio}`;
      ws.getCell('C14').value = `FECHA FIN: ${fFin}`;
      ws.getCell('A15').value = `HORAS LECTIVAS SEMANA ACTUAL: ${config.lectivasSemana}`;
      ws.getCell('C15').value = `DIAS LECTIVOS SEMANA ACTUAL: ${config.diasHabiles} DÍAS`;
      ['A14', 'C14', 'A15', 'C15'].forEach(c => ws.getCell(c).font = { size: 8 });
    };

    const groupNames = Object.keys(usersByGroup);

    for (const groupName of groupNames) {
      const safeSheetName = groupName.replace(/[\/\\\?\*\]\[]/g, '').substring(0, 30);
      const ws = wb.addWorksheet(safeSheetName);

      const rule = allSettings.find(s => s.groupName === groupName) || {} as any;
      const objDiario = Number(rule.minMinutesPerDay || defaultMin);
      const feriados = Array.isArray(rule.holidays) ? rule.holidays : [];

      const inicioG = rule.startDate ? new Date(rule.startDate) : defaultStartDate;
      const finG = rule.endDate ? new Date(rule.endDate) : defaultEndDate;
      if (inicioG) inicioG.setHours(0, 0, 0, 0);
      if (finG) finG.setHours(23, 59, 59, 999);

      let diasHabilesCount = 0;
      let minutosSemanaCabecera = 0;

      diasSemana.forEach(d => {
        const currentD = new Date(d.fechaStr + 'T12:00:00');
        let fueraDeRango = false;
        if (inicioG && currentD < inicioG) fueraDeRango = true;
        if (finG && currentD > finG) fueraDeRango = true;

        if (!feriados.includes(d.fechaStr) && !fueraDeRango) {
          diasHabilesCount++;
          minutosSemanaCabecera += objDiario;
        }
      });

      const formatSimpleHours = (mins: number) => {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${h}:${m.toString().padStart(2, '0')}`;
      };

      drawHeader(ws, {
        startDate: rule.startDate,
        endDate: rule.endDate,
        scheduleTime: rule.scheduleTime,
        diasHabiles: diasHabilesCount,
        lectivasSemana: formatSimpleHours(minutosSemanaCabecera)
      });

      // Tabla
      const headerRowIdx = 17;
      const subHeaderRowIdx = 18;
      ws.getCell(`A${headerRowIdx}`).value = 'D.N.I.';
      ws.getCell(`B${headerRowIdx}`).value = 'NOMBRE Y APELLIDOS';

      const colMap: any = { 0: 'C', 1: 'D', 2: 'E', 3: 'F', 4: 'G' };
      diasSemana.forEach((dia, index) => {
        if (colMap[index]) {
          const currentD = new Date(dia.fechaStr + 'T12:00:00');
          // Check si es feriado o fuera de rango
          let noLectivo = false;
          if (feriados.includes(dia.fechaStr)) noLectivo = true;
          if (inicioG && currentD < inicioG) noLectivo = true;
          if (finG && currentD > finG) noLectivo = true;

          ws.getCell(`${colMap[index]}${headerRowIdx}`).value = dia.diaNombre.toUpperCase();
          ws.getCell(`${colMap[index]}${subHeaderRowIdx}`).value = noLectivo ? 'FERIADO' : courseCode;
        }
      });

      const tableHeaderStyle = { font: { bold: true, size: 9 }, alignment: { horizontal: 'center', vertical: 'middle' }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } };
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].forEach(col => {
        ws.getCell(`${col}${headerRowIdx}`).style = tableHeaderStyle as any;
        ws.getCell(`${col}${subHeaderRowIdx}`).style = tableHeaderStyle as any;
        if (col === 'A' || col === 'B') ws.mergeCells(`${col}${headerRowIdx}:${col}${subHeaderRowIdx}`);
      });

      let currentRow = 19;
      const groupUsers = usersByGroup[groupName];

      for (const user of groupUsers) {
        const row = ws.getRow(currentRow);
        row.getCell(1).value = user.dni || '             ';
        row.getCell(2).value = (user.nombre || user.usuario || 'Sin Nombre').toUpperCase();

        diasSemana.forEach((dia, index) => {
          const colLetter = colMap[index];
          if (!colLetter) return;
          const cell = ws.getCell(`${colLetter}${currentRow}`);
          cell.alignment = { horizontal: 'center' };

          const currentD = new Date(dia.fechaStr + 'T12:00:00');

          let noLectivo = false;
          if (feriados.includes(dia.fechaStr)) noLectivo = true;
          if (inicioG && currentD < inicioG) noLectivo = true;
          if (finG && currentD > finG) noLectivo = true;

          if (noLectivo) {
            cell.value = 'X';
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }; // Gris
            return;
          }

          const detalle = (user.diasDetalle || []).find((d: any) => d.fecha === dia.fechaStr);

          if (detalle && detalle.minutos > 0) {
            const formatHours = (mins: number) => { const h = Math.floor(mins / 60); const m = mins % 60; return `${h}:${m.toString().padStart(2, '0')}H`; };
            cell.value = formatHours(detalle.minutos);

            if (detalle.minutos >= objDiario) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } }; // Verde
            } else {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFA500' } }; // Naranja
            }
          } else {
            cell.value = '';
          }
        });

        for (let c = 1; c <= 7; c++) {
          row.getCell(c).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        }
        currentRow++;
      }
      currentRow += 2;
      ws.getCell(`A${currentRow}`).value = 'SELLO ENTIDAD';
      ws.getCell(`A${currentRow}`).font = { size: 9 };
    }

    const safeStart = startStr;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Asistencia_${courseCode}_${safeStart}.xlsx`);

    await wb.xlsx.write(res);
    res.end();

  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'Error generando Excel' });
  }
});

// Daily export en CSV
app.get('/api/reports/daily-export', async (req: any, res: any) => {
  try {
    const { courseId, date, format, userQuery, groupId } = req.query;

    if (!courseId || !date) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    const db = await connectDB();
    const col = db.collection('asistencia');
    const settingsCol = db.collection('attendanceSettings');
    const coursesCol = db.collection('registeredCourses');

    const courseInfo = await coursesCol.findOne({ courseId: Number(courseId) });
    const allSettings = await settingsCol.find({ courseId: String(courseId).trim() }).toArray();

    let allUsersRaw = await col.find({ courseId: String(courseId) }).toArray();

    // --- CONSOLIDACIÓN DE DATOS DIARIOS ---
    const userMap = new Map<string, any>();
    allUsersRaw.forEach(u => {
      const key = String(u.usuario || u.userName || u.nombre || '').toLowerCase().trim();
      if (!key) return;
      if (!userMap.has(key)) {
        userMap.set(key, { ...u });
      } else {
        const existing = userMap.get(key);
        // Fusionamos detalles del mismo día si los hay
        const existingDates = new Set((existing.diasDetalle || []).map((d: any) => d.fecha));
        (u.diasDetalle || []).forEach((d: any) => {
          if (!existingDates.has(d.fecha)) {
            if (!existing.diasDetalle) existing.diasDetalle = [];
            existing.diasDetalle.push(d);
          }
        });
      }
    });

    let users = Array.from(userMap.values());

    const defaultMin = Number(courseInfo?.minMinutes || 170);
    const defaultSchedule = courseInfo?.scheduleTime || "00:00 - 23:59";
    const defaultStartDate = courseInfo?.startDate ? new Date(courseInfo.startDate) : null;
    const defaultEndDate = courseInfo?.endDate ? new Date(courseInfo.endDate) : null;

    if (groupId && groupId !== 'todos' && groupId !== '') {
      const targetGroupSetting = allSettings.find(s => String(s.groupId) === String(groupId));
      if (targetGroupSetting) {
        const targetName = (targetGroupSetting.groupName || '').toLowerCase().trim();
        users = users.filter((u: any) => {
          const uGroup = (u.groupName || u.grupo || '').toLowerCase().trim();
          return uGroup === targetName;
        });
      }
    }

    if (userQuery) {
      const q = String(userQuery).toLowerCase().trim();
      users = users.filter((u: any) => {
        const nombreComp = (u.nombre || u.usuario || '').toLowerCase(); // CAMBIO: Prioridad a nombre
        return nombreComp.includes(q);
      });
    }

    // ... resto del código ...

    // Helper: Convertir decimal a texto (Ej: 9.5 -> "09:30")
    const decimalToTimeStr = (dec: number) => {
      let h = Math.floor(dec);
      let m = Math.round((dec - h) * 60);
      if (m === 60) { h++; m = 0; }
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    const formatTime = (ts: number) => {
      if (!ts) return '--:--';
      const d = new Date(ts);
      return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
    };

    const previewData = [];
    const dateQuery = String(date);
    const currentD = new Date(dateQuery + 'T12:00:00');

    for (const user of users) {
      const nombre = user.nombre || user.usuario || 'Sin Nombre';
      const rawGroup = (user.groupName ?? user.grupo ?? user.group);
      const grupo = (typeof rawGroup === 'string' && rawGroup.trim()) ? rawGroup.trim() : 'Sin Grupo';

      // Buscar Regla
      const rule = allSettings.find(s => s.groupName === grupo || s.groupId === grupo) || {} as any;

      const objetivo = Number(rule.minMinutesPerDay || defaultMin);
      const horario = rule.scheduleTime || defaultSchedule;
      const feriados = Array.isArray(rule.holidays) ? rule.holidays : [];

      const inicioG = rule.startDate ? new Date(rule.startDate) : defaultStartDate;
      const finG = rule.endDate ? new Date(rule.endDate) : defaultEndDate;
      if (inicioG) inicioG.setHours(0, 0, 0, 0);
      if (finG) finG.setHours(23, 59, 59, 999);

      let limitStart = 0;
      let limitEnd = 24;
      try {
        if (horario && horario.includes('-')) {
          const parts = horario.split('-');
          const clean = (s: string) => s.trim().replace('H', '').replace(':', '.');
          limitStart = parseFloat(clean(parts[0]));
          limitEnd = parseFloat(clean(parts[1]));
        }
      } catch (e) { }

      let esNoLectivo = false;
      if (feriados.includes(dateQuery)) esNoLectivo = true;
      if (inicioG && currentD < inicioG) esNoLectivo = true;
      if (finG && currentD > finG) esNoLectivo = true;

      let minutosDia = 0;
      let entradaStr = '--:--';
      let salidaStr = '--:--';

      const detalles = Array.isArray(user.diasDetalle) ? user.diasDetalle : [];
      const diaData = detalles.find((d: any) => d.fecha === dateQuery);

      if (diaData) {
        // Valores originales por defecto
        if (diaData.firstTs) entradaStr = formatTime(diaData.firstTs);
        if (diaData.lastTs) salidaStr = formatTime(diaData.lastTs);

        if (!esNoLectivo && diaData.firstTs && diaData.lastTs) {
          const dStart = new Date(diaData.firstTs);
          const dEnd = new Date(diaData.lastTs);

          // Convertir a decimal (hora local del servidor)
          const actualStart = dStart.getHours() + (dStart.getMinutes() / 60);
          const actualEnd = dEnd.getHours() + (dEnd.getMinutes() / 60);

          const effectiveStart = Math.max(actualStart, limitStart);
          const effectiveEnd = Math.min(actualEnd, limitEnd);

          if (effectiveEnd > effectiveStart) {
            minutosDia = Math.round((effectiveEnd - effectiveStart) * 60);

            entradaStr = decimalToTimeStr(effectiveStart);
            salidaStr = decimalToTimeStr(effectiveEnd);
          } else {
            minutosDia = 0;
          }
        }
      }

      let estado = 'Ausente';
      let cumple = 'NO';

      if (esNoLectivo) {
        estado = 'No Lectivo';
        cumple = 'N/A';
        minutosDia = 0;
      } else {
        if (minutosDia > 0) estado = 'Presente';
        if (minutosDia >= objetivo) cumple = 'SI';
      }

      previewData.push({
        nombre, grupo, fecha: dateQuery,
        minutos: minutosDia, entrada: entradaStr, salida: salidaStr,
        estado, cumple, objetivo
      });
    }

    if (format === 'json') return res.json({ ok: true, data: previewData });

    // CSV Export
    const lines = [];
    const csvHeader = ['Nombre', 'Grupo', 'Fecha', 'Entrada', 'Salida', 'Minutos', 'Estado', 'Cumple'];
    const esc = (v: any) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    lines.push(csvHeader.map(esc).join(','));

    for (const row of previewData) {
      lines.push([
        row.nombre, row.grupo, row.fecha, row.entrada, row.salida,
        row.minutos, row.estado, row.cumple
      ].map(esc).join(','));
    }

    const csvContent = '\uFEFF' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=daily-export_${courseId}_${date}.csv`);
    return res.status(200).send(csvContent);

  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar reporte' });
  }
});

app.get('/api/usuarios/:courseId', async (req: any, res: any) => {
  try {
    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, req.params.courseId, { allowGlobalFallback: false });
    const response = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_enrol_get_enrolled_users',
        moodlewsrestformat: 'json',
        courseid: req.params.courseId
      }
    });
    // Mapeamos para ver solo lo importante: ID y Nombre
    const usuarios = response.data.map((u: any) => ({ id: u.id, nombre: u.fullname }));
    res.json(usuarios);
  } catch (error) {
    res.status(500).json({ error: 'Error buscando usuarios' });
  }
});

// Ruta de depuración de reportes nativos de Moodle
app.get('/api/debug/native-report', async (req: any, res: any) => {
  try {
    const reportid = req.query.reportid;
    const contextCourseId = normalizeCourseRef(req.query.courseId);
    const db = await connectDB();

    if (!reportid) {
      return res.status(400).json({ error: "Parámetro 'reportid' es requerido (?reportid=...)" });
    }

    const moodleConfig = contextCourseId
      ? await getMoodleAccessConfig(db, contextCourseId, { allowGlobalFallback: false })
      : await getMoodleAccessConfig(db, '', { allowGlobalFallback: true });

    const moodleRes = await axios.post(moodleConfig.wsUrl, null, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_reportbuilder_retrieve_report',
        moodlewsrestformat: 'json',
        reportid: reportid,
        perpage: 100
      }
    });

    // Limpiar respuesta por si Moodle mandó basura debug de PHP
    const responseData = (typeof moodleRes.data === 'string') ? cleanMoodleResponse(moodleRes.data) : moodleRes.data;

    if (responseData && (responseData.exception || responseData.errorcode)) {
      return res.status(400).json(responseData);
    }

    return res.json(responseData); // JSON crudo de Moodle
  } catch (error: any) {
    // Propagar error de Moodle sin tumbar el servidor
    if (error?.response) {
      const status = error.response.status || 400;
      return res.status(status).json(error.response.data);
    }
    console.error('❌ Error en /api/debug/native-report:', error?.message || error);
    return res.status(500).json({ error: 'Error al consultar Moodle', detalle: String(error?.message || error) });
  }
});

// Obtener configuración de asistencia por curso + grupo
app.get('/api/attendance-settings', async (req: any, res: any) => {
  try {
    const { courseId, groupId } = req.query as { courseId?: string; groupId?: string };

    if (!courseId || !groupId) {
      return res.status(400).json({ error: 'courseId y groupId son requeridos' });
    }

    const db = await connectDB();
    const col = db.collection<AttendanceSettingsDoc>('attendanceSettings');

    const doc = await col.findOne({
      courseId: String(courseId).trim(),
      groupId: String(groupId).trim(),
    });

    if (!doc) {
      return res.json({ ok: true, exists: false, settings: null });
    }

    return res.json({
      ok: true,
      exists: true,
      settings: {
        courseId: doc.courseId,
        groupId: doc.groupId,
        minMinutesPerDay: doc.minMinutesPerDay,
        globalAttendancePercent: doc.globalAttendancePercent,
        schedule: doc.schedule ?? [],
      },
    });
  } catch (err: any) {
    console.error('❌ Error en /api/attendance-settings [GET]:', err?.message || err);
    return res.status(500).json({ error: 'Error al obtener configuración', detalle: String(err?.message || err) });
  }
});

// Crear / actualizar configuración por curso + grupo (upsert)
app.post('/api/attendance-settings', async (req: any, res: any) => {
  try {
    const {
      courseId,
      groupId,
      groupName,
      minMinutesPerDay,
      globalAttendancePercent,
      schedule,
      scheduleTime,
      startDate,
      endDate,
      holidays
    } = req.body || {};

    if (!courseId || !groupId) {
      return res.status(400).json({ error: 'courseId y groupId son requeridos' });
    }

    const minMinutes = Number(minMinutesPerDay);
    if (!Number.isFinite(minMinutes) || minMinutes <= 0) {
      return res.status(400).json({ error: 'minMinutesPerDay debe ser un número mayor a 0' });
    }

    const globalPercent = Number(globalAttendancePercent);
    if (!Number.isFinite(globalPercent) || globalPercent < 0 || globalPercent > 100) {
      return res.status(400).json({ error: 'globalAttendancePercent debe estar entre 0 y 100' });
    }

    // Normalizar schedule (si lo usas, aunque ahora usamos scheduleTime texto)
    let normSchedule: AttendanceScheduleDay[] = [];
    if (Array.isArray(schedule)) {
      normSchedule = schedule
        .filter((d) => d && d.day && d.startTime && d.endTime)
        .map((d) => ({
          day: String(d.day),
          startTime: String(d.startTime),
          endTime: String(d.endTime),
        }));
    }

    const db = await connectDB();
    const col = db.collection<AttendanceSettingsDoc>('attendanceSettings');

    const now = new Date();

    const result = await col.updateOne(
      {
        courseId: String(courseId).trim(),
        groupId: String(groupId).trim(),
      },
      {
        $set: {
          courseId: String(courseId).trim(),
          groupId: String(groupId).trim(),

          groupName: groupName || '',
          startDate: startDate ? new Date(startDate + 'T12:00:00') : undefined,
          endDate: endDate ? new Date(endDate + 'T12:00:00') : undefined,

          scheduleTime: scheduleTime || '',
          holidays: Array.isArray(holidays) ? holidays : [],

          minMinutesPerDay: minMinutes,
          globalAttendancePercent: globalPercent,
          schedule: normSchedule,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true },
    );

    return res.json({
      ok: true,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedId: result.upsertedId ?? null,
    });
  } catch (err: any) {
    console.error('❌ Error en /api/attendance-settings [POST]:', err?.message || err);
    return res.status(500).json({ error: 'Error al guardar configuración', detalle: String(err?.message || err) });
  }
});

// Ruta para buscar curso por nombre (corto o largo)
app.get('/api/find-course/:query', async (req: any, res: any) => {
  try {
    const query = req.params.query.toLowerCase().trim();
    const contextCourseId = normalizeCourseRef(req.query.courseId);
    const db = await connectDB();
    const moodleConfig = contextCourseId
      ? await getMoodleAccessConfig(db, contextCourseId, { allowGlobalFallback: false })
      : await getMoodleAccessConfig(db, '', { allowGlobalFallback: true });

    console.log(`🔎 Buscando curso manualmente: "${query}"...`);

    const response = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_course_get_courses',
        moodlewsrestformat: 'json',
      }
    });

    const allCourses = response.data || [];
    const encontrado = allCourses.find((c: any) =>
      String(c.shortname).toLowerCase() === query ||
      String(c.fullname).toLowerCase().includes(query)
    );

    if (encontrado) {
      console.log(`✅ ¡Encontrado! ID: ${encontrado.id} - ${encontrado.shortname}`);
      res.json({
        ok: true,
        encontrado: true,
        id: encontrado.id,
        fullname: encontrado.fullname,
        shortname: encontrado.shortname,
        categoryid: encontrado.categoryid
      });
    } else {
      console.log('⚠️ No hubo coincidencias.');
      res.json({
        ok: true,
        encontrado: false,
        mensaje: `No encontré ningún curso que coincida con "${query}" (revisados ${allCourses.length} cursos)`
      });
    }

  } catch (error: any) {
    console.error('❌ Error buscando curso:', error.message);
    res.status(500).json({ error: 'Error conectando a Moodle' });
  }
});

// Endpoint para obtener la lista de cursos
app.get('/api/courses', async (req: any, res: any) => {
  try {
    console.log('📚 Consultando lista de cursos a Moodle...');

    const db = await connectDB();
    const registered = await db.collection('registeredCourses')
      .find({}, { projection: { courseId: 1, shortname: 1, fullname: 1 } })
      .sort({ shortname: 1 })
      .toArray();

    const listaLimpia = registered.map((c: any) => ({
      id: c.courseId,
      shortname: c.shortname,
      fullname: c.fullname
    }));

    res.json({ ok: true, cursos: listaLimpia });

  } catch (error) {
    console.error('Error al obtener cursos:', error);
    res.status(500).json({ ok: false, error: 'Error al obtener cursos registrados' });
  }
});

// Obtener grupos de un curso específico
app.get('/api/groups/:courseId', async (req: any, res: any) => {
  try {
    const { courseId } = req.params;
    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, courseId, { allowGlobalFallback: false });
    const localCourseId = moodleConfig.courseConfig?.courseId;
    const localShortname = moodleConfig.courseConfig?.shortname;
    let foundCourse = null;

    const courseIdToFind = !Number.isNaN(Number(courseId)) ? Number(courseId) : localCourseId;

    if (courseIdToFind !== undefined && courseIdToFind !== null && !Number.isNaN(Number(courseIdToFind))) {
      const idResp = await axios.get(moodleConfig.wsUrl, {
        params: {
          wstoken: moodleConfig.moodleToken,
          wsfunction: 'core_course_get_courses',
          moodlewsrestformat: 'json',
          'options[ids][0]': courseIdToFind
        }
      });
      if (idResp.data && idResp.data.length > 0) foundCourse = idResp.data[0];
    }

    if (!foundCourse) {
      const fieldResp = await axios.get(moodleConfig.wsUrl, {
        params: {
          wstoken: moodleConfig.moodleToken,
          wsfunction: 'core_course_get_courses_by_field',
          moodlewsrestformat: 'json',
          field: 'shortname',
          value: localShortname || courseId
        }
      });
      if (fieldResp.data && fieldResp.data.courses && fieldResp.data.courses.length > 0) {
        foundCourse = fieldResp.data.courses[0];
      }
    }

    if (!foundCourse) {
      return res.json({ ok: false, error: 'Curso no encontrado en Moodle' });
    }

    const groupsResp = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_group_get_course_groups',
        moodlewsrestformat: 'json',
        courseid: foundCourse.id
      }
    });

    res.json({ ok: true, groups: groupsResp.data });

  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: 'Error servidor' });
  }
});

// REGISTRAR NUEVO CURSO
app.post('/api/courses/register', async (req: any, res: any) => {
  console.log("📥 Intento de registro de curso recibido:", req.body);

  try {
    const { moodleUrl, moodleToken, courseId, entityName, cif } = req.body;

    if (!moodleUrl || !moodleToken || !courseId) {
      return res.status(400).json({ ok: false, error: 'Faltan datos (URL, Token o ID)' });
    }

    console.log(`🔌 Conectando a Moodle: ${moodleUrl} (ID: ${courseId})...`);

    let moodleCourse = null;
    let coursesList = [];

    try {
      const courseResp = await axios.get(`${moodleUrl}/webservice/rest/server.php`, {
        params: {
          wstoken: moodleToken,
          wsfunction: 'core_course_get_courses_by_field',
          moodlewsrestformat: 'json',
          field: 'id',
          value: courseId
        }
      });

      if (courseResp.data && courseResp.data.courses) {
        coursesList = courseResp.data.courses;
      } else if (Array.isArray(courseResp.data)) {
        coursesList = courseResp.data;
      }

    } catch (moodleErr: any) {
      console.error("❌ Error conectando con Moodle:", moodleErr.message);
      return res.status(502).json({ ok: false, error: `Error de conexión: ${moodleErr.message}` });
    }

    if (!coursesList || coursesList.length === 0) {
      return res.status(404).json({ ok: false, error: 'Curso no encontrado o Token sin permisos.' });
    }

    moodleCourse = coursesList[0];
    console.log(`✅ Curso encontrado: ${moodleCourse.fullname}`);

    let finalImageUrl = null;

    // Buscar en overviewfiles
    if (moodleCourse.overviewfiles && moodleCourse.overviewfiles.length > 0) {
      const file = moodleCourse.overviewfiles[0];
      let fileurl = file.fileurl;

      // Solo reemplazamos si no tiene ya el prefijo /webservice/
      if (fileurl.includes('/pluginfile.php') && !fileurl.includes('/webservice/pluginfile.php')) {
        fileurl = fileurl.replace('/pluginfile.php', '/webservice/pluginfile.php');
      }

      const symbol = fileurl.includes('?') ? '&' : '?';
      finalImageUrl = `${fileurl}${symbol}token=${moodleToken}`;

      console.log("📸 FOTO GENERADA:", finalImageUrl);
    }

    // Buscar imagen incrustada en el HTML del resumen (Plan B)
    else if (moodleCourse.summary && moodleCourse.summary.includes('<img')) {
      const match = moodleCourse.summary.match(/src="([^"]+)"/);
      if (match) {
        let fileurl = match[1];
        if (fileurl.includes('/pluginfile.php') && !fileurl.includes('/webservice/pluginfile.php')) {
          fileurl = fileurl.replace('/pluginfile.php', '/webservice/pluginfile.php');
        }

        finalImageUrl = fileurl;
        if (!finalImageUrl.includes('token=')) {
          const symbol = finalImageUrl.includes('?') ? '&' : '?';
          finalImageUrl += `${symbol}token=${moodleToken}`;
        }
        console.log("📸 FOTO ENCONTRADA EN RESUMEN (HTML)");
      }
    } else {
      console.log("⚠️ No se encontró foto para este curso.");
    }

    // Si se encontró imagen, la pasamos por el proxy local para evitar problemas de CORS/Sesión
    if (finalImageUrl) {
      finalImageUrl = `http://localhost:${PORT}/api/proxy-img?url=${encodeURIComponent(finalImageUrl)}`;
    }

    const db = await connectDB();
    const col = db.collection('registeredCourses');

    const newDoc = {
      moodleUrl,
      moodleToken,
      courseId: Number(courseId),
      shortname: moodleCourse.shortname,
      fullname: moodleCourse.fullname,
      entityName: entityName,
      cif: cif,
      imageUrl: finalImageUrl,
      startDate: moodleCourse.startdate ? new Date(moodleCourse.startdate * 1000) : null,
      endDate: moodleCourse.enddate ? new Date(moodleCourse.enddate * 1000) : null,
      minMinutes: 170,
      globalThreshold: 80,
      registeredAt: new Date()
    };

    await col.updateOne(
      { courseId: Number(courseId) },
      { $set: newDoc },
      { upsert: true }
    );

    console.log("💾 Guardado exitosamente en BD Local con foto:", finalImageUrl ? "SÍ" : "NO");
    res.json({ ok: true, course: newDoc });

  } catch (err: any) {
    console.error("🔥 Error interno:", err);
    res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  }
});

// LISTAR CURSOS
app.get('/api/courses/list', async (req: any, res: any) => {
  try {
    const db = await connectDB();
    const list = await db.collection('registeredCourses').find().toArray();

    const conFoto = list.filter(c => c.imageUrl).length;
    console.log(`📂 Enviando ${list.length} cursos al Dashboard (${conFoto} con foto)`);

    res.json({ ok: true, courses: list });
  } catch (error) {
    console.error("Error listando cursos:", error);
    res.status(500).json({ ok: false, error: 'Error de servidor' });
  }
});

app.put('/api/courses/settings', async (req: any, res: any) => {
  try {
    const { courseId, minMinutes, globalThreshold, totalHours, scheduleTime, holidays } = req.body;

    if (!courseId) {
      return res.status(400).json({ ok: false, error: 'Falta courseId' });
    }

    const db = await connectDB();
    const col = db.collection('registeredCourses');

    const updateData: any = {
      minMinutes: Number(minMinutes),
      globalThreshold: Number(globalThreshold),
    };

    if (totalHours !== undefined) updateData.totalHours = totalHours;
    if (scheduleTime !== undefined) updateData.scheduleTime = scheduleTime;
    if (holidays !== undefined) updateData.holidays = holidays;

    await col.updateOne(
      { courseId: Number(courseId) },
      { $set: updateData }
    );

    res.json({ ok: true, message: 'Configuración actualizada' });

  } catch (err) {
    console.error("Error actualizando config:", err);
    res.status(500).json({ ok: false, error: 'Error del servidor' });
  }
});

app.get('/api/attendance-settings/all/:courseId', async (req: any, res: any) => {
  try {
    const { courseId } = req.params;
    const db = await connectDB();

    const settingsList = await db.collection('attendanceSettings')
      .find({ courseId: String(courseId) })
      .toArray();

    res.json({ ok: true, groups: settingsList });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Error obteniendo grupos' });
  }
});

app.delete('/api/courses/:courseId', async (req: any, res: any) => {
  try {
    const { courseId } = req.params;

    if (!courseId) {
      return res.status(400).json({ ok: false, error: 'Falta courseId' });
    }

    const db = await connectDB();

    const result = await db.collection('registeredCourses').deleteOne({ courseId: Number(courseId) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ ok: false, error: 'Curso no encontrado' });
    }

    await db.collection('asistencia').deleteMany({ courseId: String(courseId) });

    await db.collection('attendanceSettings').deleteMany({ courseId: String(courseId) });

    console.log(`🗑️ Curso ${courseId} eliminado correctamente.`);
    res.json({ ok: true, message: 'Curso eliminado' });

  } catch (err) {
    console.error("Error eliminando curso:", err);
    res.status(500).json({ ok: false, error: 'Error del servidor' });
  }
});

// Proxy de imágenes para Moodle (Evita bloqueos de CORS y sesión)
app.get('/api/proxy-img', async (req: any, res: any) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('Falta URL');

    console.log(`🖼️ Proxyando imagen: ${imageUrl}`);

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 5000
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (error: any) {
    console.error('❌ Error en el proxy de imagen:', error.message);
    res.status(500).send('Error cargando imagen');
  }
});

// =============================================
// INSCRIPCIONES MASIVAS (Bulk Enrollment)
// =============================================

// 1. Listar TODOS los cursos de Moodle (para selector de curso origen)
app.get('/api/moodle/courses', async (req: any, res: any) => {
  try {
    const contextCourseId = normalizeCourseRef(req.query.courseId || req.query.contextCourseId);
    if (!contextCourseId) {
      return res.status(400).json({ ok: false, error: 'courseId es requerido para listar cursos de Moodle.' });
    }

    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, contextCourseId, { allowGlobalFallback: false });

    const response = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_course_get_courses',
        moodlewsrestformat: 'json'
      }
    });

    const courses = (response.data || [])
      .filter((c: any) => c.id !== 1) // Excluir el sitio principal
      .map((c: any) => ({
        id: c.id,
        shortname: c.shortname,
        fullname: c.fullname
      }));

    res.json({ ok: true, courses });
  } catch (error: any) {
    console.error('❌ Error listando cursos Moodle:', error.message);
    res.status(500).json({ ok: false, error: 'Error al conectar con Moodle' });
  }
});

// 2. Listar alumnos inscritos en un curso de Moodle
app.get('/api/moodle/enrolled-users/:courseId', async (req: any, res: any) => {
  try {
    const { courseId } = req.params;
    const contextCourseId = normalizeCourseRef(req.query.contextCourseId || req.query.courseId || courseId);
    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, contextCourseId, { allowGlobalFallback: false });

    const response = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_enrol_get_enrolled_users',
        moodlewsrestformat: 'json',
        courseid: courseId
      }
    });

    const users = (response.data || []).map((u: any) => ({
      id: u.id,
      fullname: u.fullname,
      email: u.email || '',
      roles: (u.roles || []).map((r: any) => r.shortname).join(', ')
    }));

    res.json({ ok: true, users });
  } catch (error: any) {
    console.error('❌ Error obteniendo usuarios:', error.message);
    res.status(500).json({ ok: false, error: 'Error al obtener usuarios de Moodle' });
  }
});

// 3. Inscribir alumnos masivamente en un curso destino
app.post('/api/moodle/bulk-enrol', async (req: any, res: any) => {
  try {
    const { destCourseId, userIds, roleId = 5 } = req.body;

    if (!destCourseId || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'destCourseId y userIds[] son requeridos' });
    }

    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, String(destCourseId), { allowGlobalFallback: false });

    console.log(`📥 Inscripción masiva: ${userIds.length} usuarios → Curso ${destCourseId}`);

    // 1. Obtener usuarios ya inscritos en el curso destino para filtrarlos
    let alreadyEnrolledIds: Set<number> = new Set();
    try {
      const enrolledResp = await axios.get(moodleConfig.wsUrl, {
        params: {
          wstoken: moodleConfig.moodleToken,
          wsfunction: 'core_enrol_get_enrolled_users',
          moodlewsrestformat: 'json',
          courseid: destCourseId
        }
      });
      if (Array.isArray(enrolledResp.data)) {
        enrolledResp.data.forEach((u: any) => alreadyEnrolledIds.add(u.id));
      }
    } catch (e) {
      console.log('⚠️ No se pudo verificar inscritos existentes, se intentará inscribir a todos');
    }

    // 2. Separar usuarios nuevos de los ya inscritos
    const newUserIds = userIds.filter((uid: number) => !alreadyEnrolledIds.has(uid));
    const skippedCount = userIds.length - newUserIds.length;

    if (skippedCount > 0) {
      console.log(`⏭️ ${skippedCount} usuarios ya inscritos (omitidos)`);
    }

    if (newUserIds.length === 0) {
      console.log('ℹ️ Todos los usuarios ya estaban inscritos');
      return res.json({
        ok: true,
        results: { success: 0, skipped: skippedCount, error: 0, total: userIds.length }
      });
    }

    // 3. Construir los parámetros para enrol_manual_enrol_users
    const enrolments: any = {};
    newUserIds.forEach((uid: number, index: number) => {
      enrolments[`enrolments[${index}][roleid]`] = roleId;
      enrolments[`enrolments[${index}][userid]`] = uid;
      enrolments[`enrolments[${index}][courseid]`] = destCourseId;
    });

    const response = await axios.post(
      moodleConfig.wsUrl,
      null,
      {
        params: {
          wstoken: moodleConfig.moodleToken,
          wsfunction: 'enrol_manual_enrol_users',
          moodlewsrestformat: 'json',
          ...enrolments
        }
      }
    );

    // 4. Manejar respuesta de Moodle
    let warnings: string[] = [];

    if (response.data && response.data.exception) {
      const msg = String(response.data.message || '');
      // "Message was not sent" = el correo no se envió, pero la inscripción SÍ fue exitosa
      if (msg.toLowerCase().includes('message was not sent') || msg.toLowerCase().includes('message')) {
        console.log('⚠️ Moodle no pudo enviar notificación por correo (inscripción exitosa)');
        warnings.push('Las notificaciones por correo no se enviaron, pero los alumnos fueron inscritos correctamente.');
      } else {
        // Error real de Moodle
        console.error('❌ Error real de Moodle:', msg);
        return res.status(400).json({ ok: false, error: msg || 'Error de Moodle' });
      }
    }

    console.log(`✅ Inscripción masiva completada: ${newUserIds.length} inscritos, ${skippedCount} omitidos`);
    res.json({
      ok: true,
      results: {
        success: newUserIds.length,
        skipped: skippedCount,
        error: 0,
        total: userIds.length
      },
      warnings: warnings.length > 0 ? warnings : undefined
    });
  } catch (error: any) {
    console.error('❌ Error en inscripción masiva:', error.message);
    if (error.response?.data) {
      console.error('Detalle Moodle:', JSON.stringify(error.response.data));
      const moodleError = error.response.data;
      if (moodleError.message) {
        return res.status(400).json({ ok: false, error: moodleError.message });
      }
    }
    res.status(500).json({ ok: false, error: 'Error al inscribir usuarios en Moodle' });
  }
});

// 4. Enviar correo (mensaje) de bienvenida
app.post('/api/moodle/send-welcome', async (req: any, res: any) => {
  try {
    const { courseId, userIds, courseName } = req.body;

    if (!courseId) {
      return res.status(400).json({ ok: false, error: 'courseId es requerido' });
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'userIds[] es requerido' });
    }

    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, String(courseId), { allowGlobalFallback: false });

    console.log(`✉️ Enviando mensajes de bienvenida: ${userIds.length} usuarios → Curso ${courseId}`);

    const params: any = {
      wstoken: moodleConfig.moodleToken,
      wsfunction: 'core_message_send_instant_messages',
      moodlewsrestformat: 'json',
    };

    userIds.forEach((uid: number, index: number) => {
      params[`messages[${index}][touserid]`] = uid;
      params[`messages[${index}][text]`] = `Hola! 👋 Bienvenido/a al curso "${courseName || 'del Dashboard'}". Ya estás inscrito/a y puedes comenzar tus actividades. ¡Mucho éxito!`;
      params[`messages[${index}][textformat]`] = 1; // HTML
    });

    const response = await axios.post(moodleConfig.wsUrl, null, { params });

    // 1. Error global de Moodle (Token, función no activada, etc.)
    if (response.data && response.data.exception) {
      console.error('❌ Error global de Moodle:', response.data.message);
      return res.status(400).json({ ok: false, error: `Moodle: ${response.data.message}` });
    }

    // 2. Errores individuales por mensaje
    if (Array.isArray(response.data)) {
      const firstError = response.data.find(m => m.errormessage);
      if (firstError) {
        console.error('❌ Error al enviar uno de los mensajes:', firstError.errormessage);
        return res.status(400).json({ ok: false, error: firstError.errormessage });
      }
    }

    res.json({ ok: true, count: userIds.length });
  } catch (error: any) {
    console.error('❌ Error en envío de bienvenida:', error.message);
    const errorMsg = error.response?.data?.message || error.message || 'Error desconocido';
    res.status(500).json({ ok: false, error: `Error: ${errorMsg}` });
  }
});


// =============================================
// INSCRIPCIONES CONDICIONALES (Conditional Enrollment)
// =============================================

// 1. Listar reglas de un curso
app.get('/api/moodle/conditional-rules/:courseId', async (req: any, res: any) => {
  try {
    const { courseId } = req.params;
    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, String(courseId), { allowGlobalFallback: false });
    const response = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'enrol_courseapproval_get_instances',
        moodlewsrestformat: 'json',
        courseid: courseId
      }
    });

    if (response.data && response.data.exception) {
      console.error('❌ Moodle Exception (Listar):', response.data.message);
      return res.status(400).json({ ok: false, error: response.data.message });
    }

    res.json({ ok: true, rules: response.data || [] });
  } catch (error: any) {
    console.error('❌ Error listando reglas condicionales:', error.message);
    res.status(500).json({ ok: false, error: 'Error al conectar con Moodle' });
  }
});

// 2. Agregar una nueva regla
app.post('/api/moodle/conditional-rules', async (req: any, res: any) => {
  try {
    const { courseId, sourceCourseId, roleId = 5 } = req.body;

    if (!courseId || !sourceCourseId) {
      return res.status(400).json({ ok: false, error: 'courseId y sourceCourseId son requeridos' });
    }

    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, String(courseId), { allowGlobalFallback: false });

    const response = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'enrol_courseapproval_add_instance',
        moodlewsrestformat: 'json',
        courseid: courseId,
        sourcecourseid: sourceCourseId,
        roleid: roleId
      }
    });

    if (response.data && response.data.exception) {
      console.error('❌ Moodle Exception (Agregar):', response.data.message);
      return res.status(400).json({ ok: false, error: response.data.message });
    }

    res.json({ ok: true, instanceId: response.data });
  } catch (error: any) {
    console.error('❌ Error agregando regla condicional:', error.message);
    res.status(500).json({ ok: false, error: 'Error al conectar con Moodle' });
  }
});

// 3. Eliminar una regla
app.delete('/api/moodle/conditional-rules/:instanceId', async (req: any, res: any) => {
  try {
    const { instanceId } = req.params;
    const contextCourseId = normalizeCourseRef(req.query.courseId || req.body?.courseId);
    if (!contextCourseId) {
      return res.status(400).json({ ok: false, error: 'courseId es requerido para eliminar una regla.' });
    }

    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, contextCourseId, { allowGlobalFallback: false });
    const response = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'enrol_courseapproval_delete_instance',
        moodlewsrestformat: 'json',
        instanceid: instanceId
      }
    });

    if (response.data && response.data.exception) {
      console.error('❌ Moodle Exception (Eliminar):', response.data.message);
      return res.status(400).json({ ok: false, error: response.data.message });
    }

    res.json({ ok: true, deleted: response.data });
  } catch (error: any) {
    console.error('❌ Error eliminando regla condicional:', error.message);
    res.status(500).json({ ok: false, error: 'Error al conectar con Moodle' });
  }
});

// Ruta de prueba final para verificar despliegue
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, message: 'pong (ANTIGRAVITY-1.1)', time: new Date().toISOString() });
});

// ENDPOINT SECRETO PARA GENERAR DATOS DE PRUEBA DESDE EL NAVEGADOR
app.get('/api/demo/seed/:courseId', async (req: any, res: any) => {
  try {
    const { courseId } = req.params;
    const db = await connectDB();
    const col = db.collection('asistencia');

    // Lista de usuarios que coinciden con el Dashboard
    const alumnos = [
      { usuario: 'admin', nombre: 'Administrador' },
      { usuario: 'oscar', nombre: 'Oscar Lozada' },
      { usuario: 'leonardo', nombre: 'Leonardo Barreto' },
      { usuario: 'fran', nombre: 'Fran Gutiérrez' },
      { usuario: 'barry', nombre: 'Barry Brown' },
      { usuario: 'karla', nombre: 'Karla Martinez' },
      { usuario: 'isabel', nombre: 'Isabel Castro' },
      { usuario: 'yenetsi', nombre: 'Yenetsi Rivas' }
    ];

    await col.deleteMany({ courseId: String(courseId) });
    const docs = [];
    const hoy = new Date();

    for (let i = 0; i < 15; i++) {
      const fecha = new Date();
      fecha.setDate(hoy.getDate() - i);
      if (fecha.getDay() === 0 || fecha.getDay() === 6) continue;
      const fechaStr = fecha.toISOString().split('T')[0];

      for (const alumno of alumnos) {
        const minutos = Math.floor(Math.random() * (200 - 180 + 1)) + 180;
        docs.push({
          usuario: alumno.usuario,
          nombre: alumno.nombre,
          groupName: 'Sin Grupo',
          courseId: String(courseId),
          courseShortname: 'DEMO',
          minutosTotales: minutos,
          isDemo: true,
          diasDetalle: [{
            fecha: fechaStr,
            minutos: minutos,
            entrada: '09:00',
            salida: '12:30',
            firstTs: new Date(fechaStr + 'T09:00:00').getTime(),
            lastTs: new Date(fechaStr + 'T12:30:00').getTime()
          }],
          fechaProceso: new Date()
        });
      }
    }
    await col.insertMany(docs);
    res.json({ ok: true, message: `Datos de prueba inyectados para el curso ${courseId}` });
  } catch (e) {
    res.status(500).json({ error: 'Error inyectando datos' });
  }
});

app.post('/api/auth/login', async (req: any, res: any) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Faltan credenciales' });
    }

    const db = await connectDB();
    const user = await db.collection('users').findOne({ username, password });

    if (user) {
      // Login exitoso
      res.json({
        ok: true,
        user: { username: user.username, name: user.name },
        token: 'fake-jwt-token-123' // Simulación de token
      });
    } else {
      res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Error del servidor' });
  }
});

// Middleware para capturar rutas no encontradas y logearlas
app.use((req, res) => {
  console.log(`❗ [404 NOT FOUND] ${req.method} ${req.url}`);
  res.status(404).send(`La ruta ${req.url} no existe en este servidor (ANTIGRAVITY-1.1)`);
});

app.listen(PORT, () => {
  console.log(`🚀 [ANTIGRAVITY-1.0] Servidor corriendo en http://localhost:${PORT}`);
});

async function initAdminUser() {
  try {
    const db = await connectDB();
    const usersCol = db.collection('users');
    const admin = await usersCol.findOne({ username: 'admin' });

    if (!admin) {
      console.log("🆕 Creando usuario administrador por defecto...");
      await usersCol.insertOne({
        username: 'admin',
        password: 'password123',
        name: 'Administrador'
      });
      console.log("✅ Usuario creado: admin / password123");
    }
  } catch (e) {
    console.error("Error init admin:", e);
  }
}

initAdminUser();

function calcularMinutosEnHorario(primeraHora: Date, ultimaHora: Date, horarioTexto: string): number {
  if (primeraHora.getTime() === ultimaHora.getTime()) return 0;

  let horaInicioPermitida = 0;
  let horaFinPermitida = 24;

  try {
    if (horarioTexto && horarioTexto.includes('-')) {
      const partes = horarioTexto.split('-');
      const inicioStr = partes[0].trim().replace('H', '').replace(':', '.'); // "09.00"
      const finStr = partes[1].trim().replace('H', '').replace(':', '.');    // "14.00"
      horaInicioPermitida = parseFloat(inicioStr);
      horaFinPermitida = parseFloat(finStr);
    }
  } catch (e) {
    console.log("Error parseando horario, usando default total");
  }

  const getDecimalTime = (d: Date) => d.getHours() + (d.getMinutes() / 60);

  const inicioReal = getDecimalTime(primeraHora);
  const finReal = getDecimalTime(ultimaHora);

  const inicioEfectivo = Math.max(inicioReal, horaInicioPermitida);
  const finEfectivo = Math.min(finReal, horaFinPermitida);

  if (finEfectivo > inicioEfectivo) {
    const diferenciaHoras = finEfectivo - inicioEfectivo;
    return Math.round(diferenciaHoras * 60);
  }

  return 0;
}

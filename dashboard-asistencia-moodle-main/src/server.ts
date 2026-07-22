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

console.log("✅ [DASHBOARD-ASISTENCIA-2.0] SISTEMA DE RUTAS PREPARADO");

const PORT = process.env.PORT || 3000;
const MOODLE_URL = process.env.MOODLE_URL;
const MOODLE_TOKEN = process.env.MOODLE_TOKEN;
const MINUTOS_OBJETIVO_DIARIO = 170;
// Umbral de inactividad para separar sesiones (algoritmo del bloque Course Dedication de Moodle).
// Si entre dos eventos consecutivos del log pasa MÁS de este tiempo, se considera que el alumno
// se ausentó: la sesión se cierra y el hueco NO se cuenta. Moodle usa 60 min por defecto; 30 es
// más estricto y adecuado para clases de horario fijo. Configurable vía MOODLE_IDLE_MIN.
const UMBRAL_INACTIVIDAD_MIN = Number(process.env.MOODLE_IDLE_MIN) || 30;

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

    // Horario por defecto del curso (fallback si el grupo no tiene uno propio)
    const horarioCursoDefault = courseConfig?.scheduleTime || "00:00 - 23:59";
    console.log(`🕒 Horario de corte por defecto del curso: ${horarioCursoDefault}`);

    // Cargar configuraciones de grupo para aplicar horarios específicos por grupo
    const allGroupSettings: AttendanceSettingsDoc[] = await db
      .collection<AttendanceSettingsDoc>('attendanceSettings')
      .find({ courseId: String(courseId) })
      .toArray();
    // Mapa groupName -> scheduleTime para lookup rápido
    const scheduleByGroupName = new Map<string, string>();
    allGroupSettings.forEach(gs => {
      if (gs.groupName && gs.scheduleTime) {
        scheduleByGroupName.set(gs.groupName.toLowerCase().trim(), gs.scheduleTime);
      }
    });
    console.log(`📋 Horarios por grupo cargados: ${scheduleByGroupName.size} grupos con horario propio`);

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

    // Red de seguridad: si el curso tiene reglas condicionales, heredar grupos de cada curso
    // origen para los alumnos que Moodle matriculó automáticamente (y que pueden no tener grupo
    // en este curso). Es no-fatal: si falla, el sync continúa normalmente.
    try {
      const rulesResp = await axios.get(moodleConfig.wsUrl, {
        params: {
          wstoken: moodleConfig.moodleToken,
          wsfunction: 'enrol_courseapproval_get_instances',
          moodlewsrestformat: 'json',
          courseid: moodleCourseId
        }
      });
      const condRules: any[] = Array.isArray(rulesResp.data) ? rulesResp.data : [];
      if (condRules.length > 0) {
        const destUserIds = enrolledList.map((u: any) => Number(u.id));
        for (const rule of condRules) {
          if (rule.sourcecourseid) {
            try {
              const gs = await inheritGroupsForUsers(
                moodleConfig, Number(rule.sourcecourseid), Number(moodleCourseId), destUserIds, { preCreateAllGroups: true }
              );
              if (gs.groupsCreated > 0 || gs.membershipsAdded > 0) {
                console.log(`👥 Sync grupos (regla condicional src=${rule.sourcecourseid}): ${gs.groupsCreated} creados, ${gs.membershipsAdded} membresías`);
              }
            } catch (eRule: any) {
              console.warn(`⚠️ No se pudieron sincronizar grupos desde curso origen ${rule.sourcecourseid}:`, eRule?.message || eRule);
            }
          }
        }
      }
    } catch (eCondRules: any) {
      // enrol_courseapproval puede no estar instalado — ignorar silenciosamente
      if (!String(eCondRules?.message || '').includes('accessexception')) {
        console.warn('⚠️ No se pudieron consultar reglas condicionales para sync de grupos:', eCondRules?.message || eCondRules);
      }
    }

    // Obtener Reporte de Logs — con paginación para no perder datos en cursos grandes
    const REPORT_PAGE_SIZE = 1000;
    let rows: any[] = [];
    let currentPage = 0;
    let hasMorePages = true;
    while (hasMorePages) {
      const moodleRaw = await axios.post(moodleConfig.wsUrl, null, {
        params: {
          wstoken: moodleConfig.moodleToken,
          wsfunction: 'core_reportbuilder_retrieve_report',
          moodlewsrestformat: 'json',
          reportid: 12,
          perpage: REPORT_PAGE_SIZE,
          page: currentPage
        }
      });

      const reportData = (typeof moodleRaw.data === 'string') ? cleanMoodleResponse(moodleRaw.data) : moodleRaw.data;
      const pageRows: any[] = reportData?.data?.rows || reportData?.rows || [];
      rows = rows.concat(pageRows);
      const totalRows = Number(reportData?.data?.totalrowcount ?? 0);

      if (pageRows.length < REPORT_PAGE_SIZE || rows.length >= totalRows) {
        hasMorePages = false;
      } else {
        currentPage++;
      }
    }
    console.log(`📊 Reporte Moodle: ${rows.length} filas totales (${currentPage + 1} página(s)). Enrolled: ${enrolledList.length} usuarios.`);
    if (rows.length === 0) {
      console.log(`🔍 Reporte vacío: 0 filas tras ${currentPage + 1} página(s). Verificar reportid y permisos del token.`);
    }

    // Estructuras
    type DayItem = { fecha: string; minutos: number; firstTs: number; lastTs: number; events?: number[]; entrada?: string; salida?: string; };
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

    // Registra un evento (timestamp en ms) en el día correspondiente de un usuario.
    // Mantiene firstTs/lastTs (primer y último acceso) y acumula CADA evento en events[]
    // para poder reconstruir las sesiones reales más adelante.
    // IMPORTANTE: usa fecha LOCAL del servidor (no UTC) para coherencia con el filtro
    // de horario de reconstruirMinutosSesion que usa getHours() (hora local).
    const registrarEvento = (agg: UserAgg, ts: number) => {
      const d = new Date(ts);
      const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const idx = agg.diasDetalle.findIndex((dd) => dd.fecha === fecha);
      if (idx >= 0) {
        const dia = agg.diasDetalle[idx];
        if (ts < dia.firstTs) dia.firstTs = ts;
        if (ts > dia.lastTs) dia.lastTs = ts;
        if (!dia.events) dia.events = [];
        dia.events.push(ts);
      } else {
        agg.diasDetalle.push({ fecha, minutos: 0, firstTs: ts, lastTs: ts, events: [ts] });
      }
    };

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

      if (!isMatch) continue;
      if (!user) continue;

      const rawUserKey = normalizeUserKey(user);
      const userKey = userAliasToUsername.get(rawUserKey) || rawUserKey;
      if (!byUser.has(userKey)) {
        console.log(`⚠️ SKIP usuario no matriculado: raw="${rawUserKey}" resolved="${userKey}" curso="${courseVal}"`);
        continue;
      }

      const agg = byUser.get(userKey)!;

      // Parse last access date (Col 2) - English format with AM/PM
      const dateTextRaw = toText(cells[dateIdx]);
      if (!dateTextRaw || dateTextRaw.toLowerCase() === 'never' || dateTextRaw.toLowerCase() === 'nunca') {
        console.log(`⛔ Sin acceso: "${userKey}" → "${dateTextRaw || 'vacío'}"`);
        continue;
      }
      console.log(`✅ Acceso: "${userKey}" fecha="${dateTextRaw}"`);

      const startTimestamp = parseSpanishDate(dateTextRaw);

      if (startTimestamp > 0) {
        // Timestamp de último acceso del reporte (un solo valor por fila).
        registrarEvento(agg, startTimestamp);
      }
    }

    // Fuente alternativa: lastcourseaccess desde la lista de matriculados.
    // Se usa cuando el reporte Moodle (reportid 12) falla o devuelve 0 filas.
    // El merge respeta entradas ya existentes del reporte si las hay.
    let lcaCount = 0;
    for (const u of enrolledList) {
      const uname = normalizeUserKey(u?.username);
      if (!byUser.has(uname)) continue;
      const lastCourseAccess: number = u?.lastcourseaccess ?? 0;
      if (!lastCourseAccess || lastCourseAccess <= 0) continue;

      const accessTs = lastCourseAccess * 1000; // Unix seconds → ms
      registrarEvento(byUser.get(uname)!, accessTs);
      lcaCount++;
    }
    if (lcaCount > 0) console.log(`📌 lastcourseaccess: ${lcaCount} usuarios con acceso reciente registrado.`);

    // FUENTE PRINCIPAL PARA TIEMPOS REALES: registro de eventos de Moodle.
    // Moodle core NO expone ninguna función webservice que lea logstore_standard_log
    // (verificado contra el código fuente: report/log no registra funciones WS, y
    // report_log_get_log_records no existe). Para obtener el flujo de eventos hay que
    // instalar un plugin que lo exponga (ej: local_wsgetlog) y declarar el nombre de su
    // función vía la variable de entorno MOODLE_LOG_WSFUNCTION. Cada evento aporta un
    // timestamp; con varios eventos por día se reconstruye la duración real de sesión.
    const logWsFunction = process.env.MOODLE_LOG_WSFUNCTION;
    if (logWsFunction) {
      try {
        const logWindowDays = Number(process.env.MOODLE_LOG_WINDOW_DAYS) || 180;
        const windowStart = Math.floor(Date.now() / 1000) - (logWindowDays * 24 * 60 * 60);
        console.log(`📅 Ventana de logs: últimos ${logWindowDays} días (configurable con MOODLE_LOG_WINDOW_DAYS)`);
        const logsResp = await axios.post(moodleConfig.wsUrl, null, {
          params: {
            wstoken: moodleConfig.moodleToken,
            wsfunction: logWsFunction,
            moodlewsrestformat: 'json',
            'courseids[0]': moodleCourseId,
            courseid: moodleCourseId,
            since: windowStart,
            date: windowStart,
            userid: 0,
          }
        });
        const logsData = (typeof logsResp.data === 'string') ? cleanMoodleResponse(logsResp.data) : logsResp.data;

        if (logsData?.exception || logsData?.errorcode) {
          console.warn(`⚠️ Logs (${logWsFunction}) no accesibles: ${logsData?.message || logsData?.errorcode}`);
        } else {
          // Acepta varias formas de respuesta: {logs:[...]}, {events:[...]}, {data:{rows:[...]}} o array directo.
          const logEntries: any[] = Array.isArray(logsData)
            ? logsData
            : (logsData?.logs || logsData?.events || logsData?.data?.rows || []);
          let logAssigned = 0;
          for (const entry of logEntries) {
            const userId = Number(entry.userid ?? entry.relateduserid ?? entry.realuserid);
            const username = userIdToUsername.get(userId);
            if (!username || !byUser.has(username)) continue;
            const tsSec = Number(entry.timecreated ?? entry.time ?? 0);
            if (!tsSec) continue;
            registrarEvento(byUser.get(username)!, tsSec * 1000);
            logAssigned++;
          }
          console.log(`📋 Logs reales (${logWsFunction}): ${logEntries.length} eventos → ${logAssigned} asignados.`);
        }
      } catch (logErr: any) {
        console.warn(`⚠️ Error al leer logs (${logWsFunction}):`, logErr?.response?.data?.message || logErr?.message);
      }
    } else {
      console.log('ℹ️ Sin feed de eventos (MOODLE_LOG_WSFUNCTION no definida): los minutos son estimación por acceso, no tiempo real.');
    }

    let singleEventWarnings = 0;
    byUser.forEach((userAgg) => {
      let totalUsuario = 0;
      // Usar horario del grupo del usuario; si no tiene, fallback al del curso
      const horarioUsuario = scheduleByGroupName.get((userAgg.groupName || '').toLowerCase().trim()) || horarioCursoDefault;

      userAgg.diasDetalle.forEach((dia) => {
        const eventos = (dia.events && dia.events.length) ? dia.events : [dia.firstTs];

        // Advertir cuando un día tiene un solo evento (resultará en 0 minutos)
        if (eventos.length === 1) {
          singleEventWarnings++;
        }

        const minutosReales = reconstruirMinutosSesion(eventos, horarioUsuario);

        dia.minutos = minutosReales;
        totalUsuario += minutosReales;
      });

      userAgg.minutosTotales = totalUsuario;
    });
    if (singleEventWarnings > 0) {
      console.warn(`⚠️ ${singleEventWarnings} día(s) con un solo evento registrado (= 0 minutos). Esto ocurre cuando Moodle solo registra un acceso sin actividad adicional.`);
    }

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

    return res.json({ ok: true, mensaje: `Procesados ${out.length} usuarios (horario default: ${horarioCursoDefault}, ${scheduleByGroupName.size} grupos con horario propio)`, data: out });

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

// Helper: obtiene el set de usernames actualmente matriculados en Moodle para un curso.
// Devuelve null si no se pudo consultar (fallo de red, token, etc.) para que el caller
// pueda decidir si continuar sin filtro o abortar.
async function getEnrolledUsernames(db: any, courseId: string | number): Promise<Set<string> | null> {
  try {
    const moodleConfig = await getMoodleAccessConfig(db, String(courseId));
    // Resolver el ID numérico del curso en Moodle
    let moodleCourseId: any = moodleConfig.courseConfig?.courseId ?? courseId;
    if (isNaN(Number(moodleCourseId))) {
      const allCoursesResp = await axios.get(moodleConfig.wsUrl, {
        params: { wstoken: moodleConfig.moodleToken, wsfunction: 'core_course_get_courses', moodlewsrestformat: 'json' },
        timeout: 15000
      });
      const match = (Array.isArray(allCoursesResp.data) ? allCoursesResp.data : [])
        .find((c: any) => c.shortname === String(courseId));
      if (match) moodleCourseId = match.id;
    }
    const resp = await axios.get(moodleConfig.wsUrl, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_enrol_get_enrolled_users',
        moodlewsrestformat: 'json',
        courseid: moodleCourseId
      },
      timeout: 15000
    });
    if (!Array.isArray(resp.data)) return null;
    const set = new Set<string>();
    for (const u of resp.data) {
      const uname = String(u.username ?? '').trim().toLowerCase();
      if (uname) set.add(uname);
      // También indexar por fullname y email para matcheo flexible
      const fullname = String(u.fullname ?? `${u.firstname ?? ''} ${u.lastname ?? ''}`.trim()).trim().toLowerCase();
      if (fullname) set.add(fullname);
      const email = String(u.email ?? '').trim().toLowerCase();
      if (email) set.add(email);
    }
    return set;
  } catch (e: any) {
    console.warn('⚠️ No se pudo obtener matriculados de Moodle para filtrar reporte:', e?.message || e);
    return null;
  }
}

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

    // Filtrar alumnos fantasma: solo mantener los actualmente matriculados en Moodle.
    const enrolledSet = await getEnrolledUsernames(db, courseId);
    if (enrolledSet) {
      const beforeCount = allUsers.length;
      allUsers = allUsers.filter((u: any) => {
        const uKey = String(u.usuario || u.userName || '').toLowerCase().trim();
        const uName = String(u.nombre || '').toLowerCase().trim();
        return enrolledSet.has(uKey) || enrolledSet.has(uName);
      });
      const removed = beforeCount - allUsers.length;
      if (removed > 0) {
        console.log(`🧹 Weekly export: ${removed} alumno(s) fantasma filtrado(s) (no matriculados en Moodle)`);
      }
    }

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

    // Detectar si algún grupo tiene clases en sábado para incluirlo en el reporte
    const haySabado = allSettings.some(s =>
      Array.isArray(s.schedule) && s.schedule.some((sch: any) =>
        (sch.day || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') === 'sabado'
      )
    );

    const diasSemana: { fechaStr: string, diaNombre: string }[] = [];
    let loopDate = new Date(startStr + 'T12:00:00');
    const loopEnd = new Date(endStr + 'T12:00:00');

    // Helper para fecha local YYYY-MM-DD (coherente con registrarEvento, evita desfase UTC)
    const toLocalDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    while (loopDate <= loopEnd) {
      const dayIdx = loopDate.getDay();
      // Lunes(1) a Viernes(5) siempre; Sábado(6) solo si algún grupo tiene clases ese día
      if ((dayIdx >= 1 && dayIdx <= 5) || (dayIdx === 6 && haySabado)) {
        diasSemana.push({
          fechaStr: toLocalDateStr(loopDate),
          diaNombre: getDayName(loopDate)
        });
      }
      loopDate.setDate(loopDate.getDate() + 1);
    }

    if (format === 'json') {
      const rowsData = usersFiltered.map((user: any) => {
        const gName = user.groupName || 'Sin Grupo';
        const gNameLower = gName.toLowerCase().trim();
        const rule = allSettings.find(s => (s.groupName || '').toLowerCase().trim() === gNameLower) || {} as any;

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
          ...(haySabado ? { 'Sábado': 0 } : {}),
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

        base.totalSemana = totalUserMinutes;

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

    // Columnas dinámicas según si hay sábado
    const lastCol = haySabado ? 'H' : 'G';
    const totalCols = haySabado ? 8 : 7;

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
        ...(haySabado ? [{ key: 'sabado', width: 15 }] : []),
      ];

      ws.mergeCells(`A3:${lastCol}3`); ws.getCell('A3').value = 'CONTROL DE ASISTENCIA SEMANAL';
      ws.getCell('A3').alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getCell('A3').font = { name: 'Arial', size: 14, bold: true, underline: true };

      const mes = start.toLocaleString('es-ES', { month: 'long' });
      ws.mergeCells(`A4:${lastCol}4`); ws.getCell('A4').value = `SEMANA DEL ${start.getDate()} al ${end.getDate()} de ${mes.toUpperCase()} de ${start.getFullYear()}`;
      ws.getCell('A4').alignment = { horizontal: 'center' };
      ws.getCell('A4').font = { name: 'Arial', size: 11, bold: true };

      ws.getCell('A6').value = `ENTIDAD DE FORMACIÓN: ${entidadNombre}`;
      ws.getCell('A7').value = `CENTRO DE FORMACIÓN: ${entidadNombre}`;
      ws.getCell('F6').value = `CIF ${entidadCif}`;
      ['A6', 'A7', 'F6'].forEach(c => ws.getCell(c).font = { size: 9, bold: true });

      ws.mergeCells(`A9:${lastCol}9`); ws.getCell('A9').value = `ESPECIALIDAD FORMATIVA: ${courseName.toUpperCase()}`;
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

      const groupNameLower = groupName.toLowerCase().trim();
      const rule = allSettings.find(s => (s.groupName || '').toLowerCase().trim() === groupNameLower) || {} as any;
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

      const colMap: any = { 0: 'C', 1: 'D', 2: 'E', 3: 'F', 4: 'G', 5: 'H' };
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
      const headerCols = haySabado ? ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] : ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
      headerCols.forEach(col => {
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

        for (let c = 1; c <= totalCols; c++) {
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

    // Filtrar alumnos fantasma: solo mantener los actualmente matriculados en Moodle.
    const enrolledSet = await getEnrolledUsernames(db, courseId);
    if (enrolledSet) {
      const beforeCount = users.length;
      users = users.filter((u: any) => {
        const uKey = String(u.usuario || u.userName || '').toLowerCase().trim();
        const uName = String(u.nombre || '').toLowerCase().trim();
        return enrolledSet.has(uKey) || enrolledSet.has(uName);
      });
      const removed = beforeCount - users.length;
      if (removed > 0) {
        console.log(`🧹 Daily export: ${removed} alumno(s) fantasma filtrado(s) (no matriculados en Moodle)`);
      }
    }

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

      // Buscar Regla (case-insensitive para robustez)
      const grupoLower = grupo.toLowerCase().trim();
      const rule = allSettings.find(s =>
        (s.groupName || '').toLowerCase().trim() === grupoLower || s.groupId === grupo
      ) || {} as any;

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
          // Parsear "HH:MM" o "HHhMM" a hora decimal (09:30 → 9.5, 9H30 → 9.5)
          // Coherente con parseHoraDecimal usada en reconstruirMinutosSesion
          const toDecimalHour = (s: string) => {
            const t = s.trim().replace(/H/gi, ':').replace(/\s/g, '');
            const m = t.match(/^(\d{1,2})[:.](\d{1,2})$/);
            if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
            const soloHora = t.match(/^(\d{1,2})$/);
            if (soloHora) return parseInt(soloHora[1], 10);
            return 0;
          };
          limitStart = toDecimalHour(parts[0]);
          limitEnd = toDecimalHour(parts[1]);
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

        if (!esNoLectivo) {
          // Los minutos REALES ya fueron calculados en /api/dailystats (reconstrucción de
          // sesiones cuando hay feed de eventos, o estimación por acceso si no lo hay).
          // Aquí se confía en ese valor para mantener consistencia con el dashboard.
          minutosDia = diaData.minutos ?? 0;

          // Entrada/salida solo para visualización: primer y último acceso recortados al horario.
          if (diaData.firstTs && diaData.lastTs) {
            const dStart = new Date(diaData.firstTs);
            const dEnd = new Date(diaData.lastTs);
            const actualStart = dStart.getHours() + (dStart.getMinutes() / 60);
            const actualEnd = dEnd.getHours() + (dEnd.getMinutes() / 60);

            const effectiveStart = Math.max(actualStart, limitStart);
            let effectiveEnd = Math.min(actualEnd, limitEnd);

            // Acceso único: sintetizar la salida a partir de los minutos estimados.
            if (diaData.firstTs === diaData.lastTs && minutosDia > 0) {
              effectiveEnd = Math.min(effectiveStart + (minutosDia / 60), limitEnd);
            }

            if (effectiveEnd >= effectiveStart) {
              entradaStr = decimalToTimeStr(effectiveStart);
              salidaStr = decimalToTimeStr(effectiveEnd);
            }
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
app.get('/api/debug/list-reports', async (req: any, res: any) => {
  try {
    const db = await connectDB();
    const moodleConfig = await getMoodleAccessConfig(db, null as any, { allowGlobalFallback: true });
    const resp = await axios.post(moodleConfig.wsUrl, null, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_reportbuilder_list_reports',
        moodlewsrestformat: 'json',
        perpage: 100,
        pagenumber: 0,
      }
    });
    const data = (typeof resp.data === 'string') ? cleanMoodleResponse(resp.data) : resp.data;
    return res.json({ ok: true, data });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message, detail: err?.response?.data });
  }
});

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

    // Normaliza una URL de archivo de Moodle: usa /webservice/pluginfile.php y agrega el token
    const buildMoodleFileUrl = (rawUrl: string): string => {
      let fileurl = rawUrl;
      if (fileurl.includes('/pluginfile.php') && !fileurl.includes('/webservice/pluginfile.php')) {
        fileurl = fileurl.replace('/pluginfile.php', '/webservice/pluginfile.php');
      }
      if (!fileurl.includes('token=')) {
        const symbol = fileurl.includes('?') ? '&' : '?';
        fileurl += `${symbol}token=${moodleToken}`;
      }
      return fileurl;
    };

    // Plan A: imagen oficial subida al curso (overviewfiles)
    if (moodleCourse.overviewfiles && moodleCourse.overviewfiles.length > 0) {
      finalImageUrl = buildMoodleFileUrl(moodleCourse.overviewfiles[0].fileurl);
      console.log("📸 FOTO DESDE overviewfiles:", finalImageUrl);
    }

    // Plan B: imagen incrustada en el HTML del resumen del curso
    else if (moodleCourse.summary && moodleCourse.summary.includes('<img')) {
      const match = moodleCourse.summary.match(/src="([^"]+)"/);
      if (match) {
        finalImageUrl = buildMoodleFileUrl(match[1]);
        console.log("📸 FOTO ENCONTRADA EN RESUMEN (HTML)");
      }
    }

    // Plan C: foto incrustada en el contenido del curso (banner de la sección).
    // Requiere que el usuario del token tenga acceso al curso; si no, lanza accessexception.
    if (!finalImageUrl) {
      try {
        const contentResp = await axios.get(`${moodleUrl}/webservice/rest/server.php`, {
          params: {
            wstoken: moodleToken,
            wsfunction: 'core_course_get_contents',
            moodlewsrestformat: 'json',
            courseid: Number(courseId)
          }
        });
        const sections = Array.isArray(contentResp.data) ? contentResp.data : [];
        outer:
        for (const sec of sections) {
          const htmlBlocks = [sec.summary, ...(sec.modules || []).map((m: any) => m.description)];
          for (const html of htmlBlocks) {
            if (html && html.includes('<img')) {
              const m = html.match(/src="([^"]+)"/);
              if (m && /\.(png|jpe?g|gif|webp|svg)/i.test(m[1])) {
                finalImageUrl = buildMoodleFileUrl(m[1]);
                console.log("📸 FOTO ENCONTRADA EN CONTENIDO DEL CURSO");
                break outer;
              }
            }
          }
        }
      } catch (contentErr: any) {
        const reason = contentErr.response?.data?.errorcode || contentErr.message;
        console.log(`⚠️ No se pudo leer el contenido del curso (${reason}).`);
      }
    }

    // Plan D: imagen que genera Moodle (patrón de colores) como último recurso
    if (!finalImageUrl && moodleCourse.courseimage) {
      finalImageUrl = buildMoodleFileUrl(moodleCourse.courseimage);
      console.log("📸 FOTO GENERADA POR MOODLE (courseimage):", finalImageUrl);
    }

    if (!finalImageUrl) {
      console.log("⚠️ No se encontró foto para este curso.");
    }

    // Usamos ruta relativa para que funcione en dev (Vite proxy) y producción
    if (finalImageUrl) {
      finalImageUrl = `/api/proxy-img?url=${encodeURIComponent(finalImageUrl)}`;
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
    const list = await db.collection('registeredCourses').find().sort({ sortOrder: 1 }).toArray();

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

// Guarda el orden de las tarjetas (array de courseIds en el orden deseado)
app.put('/api/courses/order', async (req: any, res: any) => {
  try {
    const { order } = req.body; // [courseId1, courseId2, ...]
    if (!Array.isArray(order)) return res.status(400).json({ ok: false, error: 'order debe ser un array' });

    const db = await connectDB();
    const col = db.collection('registeredCourses');
    await Promise.all(order.map((courseId: number, index: number) =>
      col.updateOne({ courseId: Number(courseId) }, { $set: { sortOrder: index } })
    ));
    res.json({ ok: true });
  } catch (err) {
    console.error('Error guardando orden:', err);
    res.status(500).json({ ok: false, error: 'Error del servidor' });
  }
});

// Sincroniza el orden leyendo las secciones del curso padre en Moodle
app.post('/api/courses/sync-order-from-moodle', async (req: any, res: any) => {
  try {
    const { parentCourseId } = req.body;
    if (!parentCourseId) return res.status(400).json({ ok: false, error: 'Falta parentCourseId' });

    const db = await connectDB();
    const col = db.collection('registeredCourses');

    // Tomar moodleUrl y token de cualquier curso registrado
    const anyCourse = await col.findOne({});
    if (!anyCourse) return res.status(404).json({ ok: false, error: 'No hay cursos registrados' });

    const { moodleUrl, moodleToken } = anyCourse;

    const resp = await axios.get(`${moodleUrl}/webservice/rest/server.php`, {
      params: {
        wstoken: moodleToken,
        wsfunction: 'core_course_get_contents',
        moodlewsrestformat: 'json',
        courseid: Number(parentCourseId)
      },
      timeout: 15000
    });

    if (!Array.isArray(resp.data)) {
      const err = resp.data?.errorcode || resp.data?.error || 'Respuesta inesperada';
      return res.status(502).json({ ok: false, error: `Error de Moodle: ${err}` });
    }

    const registered = await col.find({}).toArray();

    // Normaliza un texto para comparación: minúsculas, sin espacios extra, sin tabulaciones
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

    // Extrae nombres de módulos subcourse en orden de sección (el curso padre usa el plugin subcourse)
    // Estrategia de emparejamiento:
    //   1. shortname exacto al inicio del nombre del módulo  (ej: "FCOS02 BÁSICO...")
    //   2. fullname normalizado contiene al nombre del módulo normalizado o viceversa
    const orderedCourseIds: number[] = [];
    const log: string[] = [];

    for (const section of resp.data) {
      for (const mod of (section.modules || [])) {
        const modNameNorm = normalize(mod.name || '');
        if (!modNameNorm) continue;

        // Buscar el curso registrado que mejor coincide con este módulo
        let matched = registered.find(r => {
          // Coincidencia por shortname al inicio del nombre del módulo
          const sn = normalize(r.shortname || '');
          if (sn && modNameNorm.startsWith(sn)) return true;
          // Coincidencia por fullname normalizado
          const fn = normalize(r.fullname || '');
          if (fn && (modNameNorm.includes(fn) || fn.includes(modNameNorm))) return true;
          return false;
        });

        if (matched && !orderedCourseIds.includes(matched.courseId)) {
          orderedCourseIds.push(matched.courseId);
          log.push(`Sección ${section.section} [${mod.modname}] "${mod.name}" → courseId:${matched.courseId} (${matched.shortname})`);
        } else if (!matched) {
          log.push(`Sección ${section.section} [${mod.modname}] "${mod.name}" → SIN COINCIDENCIA`);
        }
      }
    }

    console.log('=== Sync orden desde Moodle ===\n' + log.join('\n'));

    if (orderedCourseIds.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'No se encontraron coincidencias entre los módulos del curso padre y los cursos registrados.'
      });
    }

    // Aplicar sortOrder a los cursos encontrados
    let applied = 0;
    for (let i = 0; i < orderedCourseIds.length; i++) {
      const result = await col.updateOne(
        { courseId: orderedCourseIds[i] },
        { $set: { sortOrder: i } }
      );
      if (result.matchedCount > 0) applied++;
    }

    // Cursos registrados no presentes en el padre van al final
    const remaining = registered.filter(r => !orderedCourseIds.includes(r.courseId));
    for (let i = 0; i < remaining.length; i++) {
      await col.updateOne({ courseId: remaining[i].courseId }, { $set: { sortOrder: orderedCourseIds.length + i } });
    }

    res.json({ ok: true, orderedCourseIds, applied, log, message: `${applied} cursos reordenados desde Moodle` });
  } catch (err: any) {
    console.error('Error sincronizando orden desde Moodle:', err);
    res.status(500).json({ ok: false, error: err.message });
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

app.delete('/api/attendance-settings/:courseId/:groupId', async (req: any, res: any) => {
  try {
    const { courseId, groupId } = req.params;
    if (!courseId || !groupId) {
      return res.status(400).json({ ok: false, error: 'courseId y groupId son requeridos' });
    }
    const db = await connectDB();
    const result = await db.collection('attendanceSettings').deleteOne({
      courseId: String(courseId).trim(),
      groupId: String(groupId).trim(),
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ ok: false, error: 'Configuración de grupo no encontrada' });
    }
    return res.json({ ok: true, message: 'Grupo eliminado correctamente' });
  } catch (err: any) {
    console.error('❌ Error en DELETE /api/attendance-settings:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Error al eliminar grupo' });
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

// Helper: hereda los grupos del curso origen al curso destino para los usuarios indicados.
// Por cada grupo del origen donde esté el usuario, crea (si falta) un grupo con el mismo
// nombre en el destino y añade al usuario. No es fatal: si algo falla, la inscripción se mantiene.
// Opciones:
//   preCreateAllGroups: true → crea TODOS los grupos del origen en el destino aunque no haya
//     usuarios relevantes (útil para reglas condicionales donde los alumnos llegarán después).
async function inheritGroupsForUsers(
  moodleConfig: any,
  sourceCourseId: number,
  destCourseId: number,
  userIds: number[],
  opts?: { preCreateAllGroups?: boolean }
): Promise<{ groupsCreated: number; membershipsAdded: number }> {
  const summary = { groupsCreated: 0, membershipsAdded: 0 };
  const preCreate = opts?.preCreateAllGroups ?? false;

  if (!sourceCourseId || !destCourseId) return summary;
  if (!preCreate && (!Array.isArray(userIds) || userIds.length === 0)) return summary;

  const userIdSet = new Set((userIds || []).map(Number));

  // 1. Grupos del curso origen.
  const srcGroupsResp = await axios.get(moodleConfig.wsUrl, {
    params: {
      wstoken: moodleConfig.moodleToken,
      wsfunction: 'core_group_get_course_groups',
      moodlewsrestformat: 'json',
      courseid: sourceCourseId
    }
  });
  const srcGroups: any[] = Array.isArray(srcGroupsResp.data) ? srcGroupsResp.data : [];
  if (srcGroups.length === 0) return summary;

  // 2. Miembros de cada grupo del origen (para asignar usuarios al destino).
  const memberParams: any = {};
  srcGroups.forEach((g: any, i: number) => { memberParams[`groupids[${i}]`] = g.id; });
  const membersResp = await axios.get(moodleConfig.wsUrl, {
    params: {
      wstoken: moodleConfig.moodleToken,
      wsfunction: 'core_group_get_group_members',
      moodlewsrestformat: 'json',
      ...memberParams
    }
  });
  const membersByGroup: any[] = Array.isArray(membersResp.data) ? membersResp.data : [];

  // srcGroupId -> [userIds nuestros que están en ese grupo]
  const relevantByGroup = new Map<number, number[]>();
  membersByGroup.forEach((m: any) => {
    const relevant = (m.userids || []).map(Number).filter((uid: number) => userIdSet.has(uid));
    if (relevant.length > 0) relevantByGroup.set(Number(m.groupid), relevant);
  });

  // Si no hay usuarios relevantes y no se pidió pre-crear, salir
  if (relevantByGroup.size === 0 && !preCreate) return summary;

  // 3. Grupos existentes en el destino (nombre -> id).
  const destGroupsResp = await axios.get(moodleConfig.wsUrl, {
    params: {
      wstoken: moodleConfig.moodleToken,
      wsfunction: 'core_group_get_course_groups',
      moodlewsrestformat: 'json',
      courseid: destCourseId
    }
  });
  const destGroups: any[] = Array.isArray(destGroupsResp.data) ? destGroupsResp.data : [];
  const destIdByName = new Map<string, number>();
  destGroups.forEach((g: any) => destIdByName.set(g.name, g.id));

  const srcGroupById = new Map<number, any>();
  srcGroups.forEach((g: any) => srcGroupById.set(Number(g.id), g));

  // 4. Asegurar grupo destino por nombre (crear si falta) y juntar membresías a añadir.
  const membersToAdd: { groupid: number; userid: number }[] = [];

  // Decidir qué grupos del origen iterar: si preCreate, TODOS; si no, solo los que tengan usuarios.
  const groupIdsToProcess: number[] = preCreate
    ? srcGroups.map((g: any) => Number(g.id))
    : Array.from(relevantByGroup.keys());

  for (const srcGroupId of groupIdsToProcess) {
    const srcGroup = srcGroupById.get(srcGroupId);
    if (!srcGroup) continue;

    let destGroupId = destIdByName.get(srcGroup.name);
    if (!destGroupId) {
      const createResp = await axios.post(moodleConfig.wsUrl, null, {
        params: {
          wstoken: moodleConfig.moodleToken,
          wsfunction: 'core_group_create_groups',
          moodlewsrestformat: 'json',
          'groups[0][courseid]': destCourseId,
          'groups[0][name]': srcGroup.name,
          'groups[0][description]': srcGroup.description || '',
          'groups[0][descriptionformat]': srcGroup.descriptionformat ?? 1
        }
      });
      if (Array.isArray(createResp.data) && createResp.data[0] && createResp.data[0].id) {
        destGroupId = Number(createResp.data[0].id);
        destIdByName.set(srcGroup.name, destGroupId);
        summary.groupsCreated++;
      } else {
        continue; // No se pudo crear el grupo; lo saltamos.
      }
    }

    // Añadir membresías solo si hay usuarios relevantes en este grupo
    const relevantUsers = relevantByGroup.get(srcGroupId);
    if (relevantUsers) {
      relevantUsers.forEach((uid) => membersToAdd.push({ groupid: destGroupId as number, userid: uid }));
    }
  }

  // 5. Añadir miembros en lote.
  if (membersToAdd.length > 0) {
    const addParams: any = {};
    membersToAdd.forEach((m, i) => {
      addParams[`members[${i}][groupid]`] = m.groupid;
      addParams[`members[${i}][userid]`] = m.userid;
    });
    await axios.post(moodleConfig.wsUrl, null, {
      params: {
        wstoken: moodleConfig.moodleToken,
        wsfunction: 'core_group_add_group_members',
        moodlewsrestformat: 'json',
        ...addParams
      }
    });
    summary.membershipsAdded = membersToAdd.length;
  }

  return summary;
}

// 3. Inscribir alumnos masivamente en un curso destino
app.post('/api/moodle/bulk-enrol', async (req: any, res: any) => {
  try {
    const { destCourseId, userIds, roleId = 5, sourceCourseId } = req.body;

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

    // 5. Heredar los grupos del curso origen (si se indicó). No es fatal: la inscripción ya fue exitosa.
    let groupSync: { groupsCreated: number; membershipsAdded: number } | undefined;
    if (sourceCourseId) {
      try {
        groupSync = await inheritGroupsForUsers(moodleConfig, Number(sourceCourseId), Number(destCourseId), newUserIds);
        if (groupSync.groupsCreated > 0 || groupSync.membershipsAdded > 0) {
          console.log(`👥 Grupos heredados: ${groupSync.groupsCreated} creados, ${groupSync.membershipsAdded} membresías añadidas`);
        }
      } catch (e: any) {
        console.log('⚠️ No se pudieron heredar los grupos del curso origen:', e?.message || e);
        warnings.push('Los alumnos fueron inscritos, pero no se pudieron heredar todos los grupos del curso origen.');
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
      groupSync,
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

    // Heredar grupos del curso origen al destino.
    // 1) Pre-crear los grupos del origen en el destino (para que existan cuando se matriculen alumnos).
    // 2) Si ya hay alumnos matriculados en ambos cursos, asignarlos a sus grupos correspondientes.
    let groupSync: { groupsCreated: number; membershipsAdded: number } | undefined;
    const warnings: string[] = [];
    try {
      // Obtener alumnos matriculados en el curso destino
      const enrolledDestResp = await axios.get(moodleConfig.wsUrl, {
        params: {
          wstoken: moodleConfig.moodleToken,
          wsfunction: 'core_enrol_get_enrolled_users',
          moodlewsrestformat: 'json',
          courseid: courseId
        }
      });
      const destUsers: any[] = Array.isArray(enrolledDestResp.data) ? enrolledDestResp.data : [];
      const destUserIds = destUsers.map((u: any) => Number(u.id));

      // inheritGroupsForUsers con preCreateAllGroups: crea TODOS los grupos del origen en el
      // destino aunque no haya alumnos aún, y asigna membresías para los que ya estén en ambos.
      groupSync = await inheritGroupsForUsers(moodleConfig, Number(sourceCourseId), Number(courseId), destUserIds, { preCreateAllGroups: true });
      if (groupSync.groupsCreated > 0 || groupSync.membershipsAdded > 0) {
        console.log(`👥 Regla condicional: grupos heredados: ${groupSync.groupsCreated} creados, ${groupSync.membershipsAdded} membresías añadidas`);
      }
    } catch (e: any) {
      console.log('⚠️ Regla condicional: no se pudieron heredar grupos del curso origen:', e?.message || e);
      warnings.push('La regla se creó, pero no se pudieron heredar todos los grupos del curso origen.');
    }

    res.json({ ok: true, instanceId: response.data, groupSync, warnings: warnings.length > 0 ? warnings : undefined });
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
  res.json({ ok: true, message: 'pong (DASHBOARD-ASISTENCIA-2.0)', time: new Date().toISOString() });
});

// =============================================
// DIAGNÓSTICO DE PERMISOS Y CONECTIVIDAD
// GET /api/diagnostics/:courseId
// Prueba todas las funciones WS que usa la app y reporta cuáles están habilitadas.
// =============================================
app.get('/api/diagnostics/:courseId', async (req: any, res: any) => {
  const { courseId } = req.params;

  const results: Record<string, { ok: boolean; detail: string }> = {};

  let moodleConfig: any;
  try {
    const db = await connectDB();
    moodleConfig = await getMoodleAccessConfig(db, String(courseId), { allowGlobalFallback: false });
    results['config'] = { ok: true, detail: `Token y URL de Moodle resueltos para curso ${courseId}` };
  } catch (e: any) {
    return res.json({
      ok: false,
      summary: 'No se pudo obtener la configuración de Moodle para este curso.',
      results: { config: { ok: false, detail: e.message } }
    });
  }

  const probe = async (label: string, wsfunction: string, extraParams: Record<string, any> = {}) => {
    try {
      const resp = await axios.get(moodleConfig.wsUrl, {
        params: { wstoken: moodleConfig.moodleToken, wsfunction, moodlewsrestformat: 'json', ...extraParams },
        timeout: 8000
      });
      const data = resp.data;
      if (data && data.exception) {
        // "invalidparameter" → función existe pero recibió parámetros de prueba vacíos (ok)
        if (data.errorcode === 'invalidparameter' || data.errorcode === 'missingparam') {
          results[label] = { ok: true, detail: 'Función accesible (error de parámetros esperado en prueba)' };
        } else if (data.errorcode === 'accessexception' || data.errorcode === 'nopermissions') {
          results[label] = { ok: false, detail: `Sin permiso: ${data.message}` };
        } else if (data.errorcode === 'invalidrecord' || data.errorcode === 'dml_missing_record_exception') {
          results[label] = { ok: true, detail: 'Función accesible (registro de prueba no existe, normal)' };
        } else {
          results[label] = { ok: false, detail: `Error Moodle [${data.errorcode}]: ${data.message}` };
        }
      } else {
        results[label] = { ok: true, detail: 'Función accesible y responde correctamente' };
      }
    } catch (e: any) {
      results[label] = { ok: false, detail: `Error de red: ${e.message}` };
    }
  };

  // --- Funciones core ya existentes ---
  await probe('core_enrol_get_enrolled_users',    'core_enrol_get_enrolled_users',    { courseid: courseId });
  await probe('enrol_manual_enrol_users',          'enrol_manual_enrol_users',          {});
  await probe('core_group_get_course_groups',      'core_group_get_course_groups',      { courseid: courseId });
  await probe('core_group_get_group_members',      'core_group_get_group_members',      { 'groupids[0]': 0 });
  await probe('core_message_send_instant_messages','core_message_send_instant_messages',{});

  // --- Funciones nuevas del plugin de inscripción condicional ---
  await probe('enrol_courseapproval_get_instances',   'enrol_courseapproval_get_instances',   { courseid: courseId });
  await probe('enrol_courseapproval_add_instance',    'enrol_courseapproval_add_instance',    {});
  await probe('enrol_courseapproval_delete_instance', 'enrol_courseapproval_delete_instance', {});

  // --- Funciones nuevas para herencia de grupos ---
  await probe('core_group_create_groups',    'core_group_create_groups',    {});
  await probe('core_group_add_group_members','core_group_add_group_members',{});

  const total   = Object.keys(results).length;
  const passing = Object.values(results).filter(r => r.ok).length;
  const failing = Object.values(results).filter(r => !r.ok);

  res.json({
    ok: failing.length === 0,
    summary: `${passing}/${total} funciones OK${failing.length ? ' — ' + failing.map(f => Object.keys(results).find(k => results[k] === f)).join(', ') + ' fallaron' : ''}`,
    results
  });
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
        user: { username: user.username, name: user.name, role: user.role || 'viewer' },
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

// --- GESTIÓN DE USUARIOS ---
app.get('/api/auth/users', async (req: any, res: any) => {
  try {
    const db = await connectDB();
    const users = await db.collection('users').find({}, { projection: { password: 0 } }).toArray();
    res.json({ ok: true, users });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error obteniendo usuarios' });
  }
});

app.post('/api/auth/users', async (req: any, res: any) => {
  try {
    const { username, password, name, role } = req.body;
    if (!username || !password || !name) {
      return res.status(400).json({ ok: false, error: 'username, password y name son requeridos' });
    }
    const db = await connectDB();
    const existing = await db.collection('users').findOne({ username });
    if (existing) {
      return res.status(409).json({ ok: false, error: 'El usuario ya existe' });
    }
    await db.collection('users').insertOne({
      username,
      password,
      name,
      role: role === 'admin' ? 'admin' : 'viewer'
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error creando usuario' });
  }
});

app.delete('/api/auth/users/:username', async (req: any, res: any) => {
  try {
    const { username } = req.params;
    if (username === 'admin') {
      return res.status(403).json({ ok: false, error: 'No se puede eliminar el usuario admin' });
    }
    const db = await connectDB();
    const result = await db.collection('users').deleteOne({ username });
    if (result.deletedCount === 0) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error eliminando usuario' });
  }
});

// Middleware para capturar rutas no encontradas y logearlas
app.use((req, res) => {
  console.log(`❗ [404 NOT FOUND] ${req.method} ${req.url}`);
  res.status(404).send(`La ruta ${req.url} no existe en este servidor (DASHBOARD-ASISTENCIA-2.0)`);
});

app.listen(PORT, () => {
  console.log(`🚀 [DASHBOARD-ASISTENCIA-2.0] Servidor corriendo en http://localhost:${PORT}`);
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
        name: 'Administrador',
        role: 'admin'
      });
      console.log("✅ Usuario creado: admin / password123");
    } else if (!admin.role) {
      await usersCol.updateOne({ username: 'admin' }, { $set: { role: 'admin' } });
    }
  } catch (e) {
    console.error("Error init admin:", e);
  }
}

initAdminUser();

// Parsea "HH:MM" a hora decimal REAL: "09:30" -> 9.5 (no 9.30). Acepta "9H30", "09:30", "9".
function parseHoraDecimal(str: string, fallback: number): number {
  if (!str) return fallback;
  const limpio = str.trim().replace(/H/gi, ':').replace(/\s/g, '');
  const m = limpio.match(/^(\d{1,2})[:.](\d{1,2})$/);
  if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  const soloHora = limpio.match(/^(\d{1,2})$/);
  if (soloHora) return parseInt(soloHora[1], 10);
  return fallback;
}

// Reconstruye los MINUTOS REALES de sesión a partir de TODOS los eventos de un día.
// Replica el algoritmo del bloque Course Dedication de Moodle (verificado contra su código):
//   1. ordena los eventos por tiempo,
//   2. recorre: si el hueco entre dos eventos consecutivos SUPERA el umbral de inactividad,
//      cierra la sesión actual (el hueco NO se cuenta) y abre una nueva,
//   3. la duración de cada sesión = último clic - primer clic de esa sesión,
//   4. suma todas las sesiones del día.
// Además recorta los eventos a la ventana horaria del curso (ej: 09:00-14:00).
// Un solo evento => 0 (la duración real es desconocida; ese caso lo trata el llamador).
function reconstruirMinutosSesion(
  eventosMs: number[],
  horarioTexto: string,
  umbralInactividadMin: number = UMBRAL_INACTIVIDAD_MIN
): number {
  if (!eventosMs || eventosMs.length === 0) return 0;

  // Ventana horaria permitida (hora decimal local).
  let horaInicio = 0;
  let horaFin = 24;
  if (horarioTexto && horarioTexto.includes('-')) {
    const partes = horarioTexto.split('-');
    horaInicio = parseHoraDecimal(partes[0], 0);
    horaFin = parseHoraDecimal(partes[1], 24);
  }

  const dentroHorario = (ts: number) => {
    const d = new Date(ts);
    const h = d.getHours() + d.getMinutes() / 60;
    return h >= horaInicio && h <= horaFin;
  };

  const ev = eventosMs.filter(dentroHorario).sort((a, b) => a - b);
  if (ev.length < 2) return 0;

  const umbralMs = umbralInactividadMin * 60_000;
  let sessionStart = ev[0];
  let prev = ev[0];
  let totalMs = 0;

  for (let i = 1; i < ev.length; i++) {
    const t = ev[i];
    if (t - prev > umbralMs) {          // hueco > umbral -> cierra la sesión
      totalMs += prev - sessionStart;   // cuenta solo primer..último clic de la sesión
      sessionStart = t;                 // abre una sesión nueva
    }
    prev = t;
  }
  totalMs += prev - sessionStart;       // CRÍTICO: cerrar la última sesión abierta

  return Math.round(totalMs / 60_000);
}

// calcularMinutosEnHorario eliminada — era código muerto reemplazado por reconstruirMinutosSesion.

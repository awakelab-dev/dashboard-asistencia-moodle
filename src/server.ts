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

const PORT = process.env.PORT || 3000;
const MOODLE_URL = process.env.MOODLE_URL;
const MOODLE_TOKEN = process.env.MOODLE_TOKEN;
const MINUTOS_OBJETIVO_DIARIO = 170;

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

app.get('/api/curso/:id', async (req: any, res: any) => {
  try {
    const courseId = req.params.id;
    console.log(`Buscando curso ID: ${courseId}...`);

    const response = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
      params: {
        wstoken: MOODLE_TOKEN,
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

    console.log(`🕵🏻‍♀️ Buscando: Usuario="${userEmail}" en Curso="${courseShortname}"...`);

    const moodleResponse = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
      params: {
        wstoken: MOODLE_TOKEN,
        wsfunction: 'core_reportbuilder_retrieve_report',
        moodlewsrestformat: 'json',
        reportid: 18,
        perpage: 10000,
      }
    });

    const raw = moodleResponse.data;
    const rows = raw.data?.rows || [];

    console.log(`📊 Moodle respondió con ${raw.data?.totalrowcount || 0} filas.`);

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
        'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11
      };
      try {
        const regex = /(\d{1,2})[\s\u00A0]+de[\s\u00A0]+([a-zA-Zñ]+)[\s\u00A0]+de[\s\u00A0]+(\d{4}),[\s\u00A0]+(\d{1,2}):(\d{2})/;

        const match = dateStr.toLowerCase().match(regex);

        if (match) {
          const dia = parseInt(match[1]);
          const mesNombre = match[2];
          const anio = parseInt(match[3]);
          const hora = parseInt(match[4]);
          const min = parseInt(match[5]);
          const mesIndex = meses[mesNombre] ?? 0;
          return new Date(anio, mesIndex, dia, hora, min).getTime();
        }
      } catch (e) { console.warn('Error fecha:', dateStr); }
      return 0;
    };

    let minutosTotales = 0;
    let entradasEncontradas = 0;
    let ultimoAccesoUnix = 0;

    for (const row of rows) {
      const columnas = row.columns;

      const rowUser = String(columnas[1]).toLowerCase();
      const rowCourse = String(columnas[2]);

      // Match
      const userMatch = rowUser.includes(userEmail.toLowerCase());
      const courseMatch = courseShortname ? (rowCourse === courseShortname) : true;

      if (userMatch && courseMatch) {
        const duracionTexto = columnas[3];
        const minutosFila = parseDuration(duracionTexto);
        minutosTotales += minutosFila;
        entradasEncontradas++;

        const fechaTexto = String(columnas[4]);
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

    const db = await connectDB();
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
    const courseShortname = (req.query.courseShortname || courseId || '').toString().trim();

    if (!MOODLE_URL || !MOODLE_TOKEN) {
      return res.status(500).json({ error: 'Configuración de Moodle incompleta.' });
    }

    if (!courseId) {
      return res.status(400).json({ error: 'courseId es requerido.' });
    }

    const db = await connectDB();
    const courseConfig = await db.collection('registeredCourses').findOne({ courseId: Number(courseId) });
    // Si no hay horario definido, usamos un default amplio (ej: 00:00 - 23:59)
    const horarioCurso = courseConfig?.scheduleTime || "00:00 - 23:59";
    console.log(`🕒 Aplicando horario de corte: ${horarioCurso}`);

    let moodleCourseId = courseId;

    // Validación de ID numérico...
    if (isNaN(Number(courseId))) {
      try {
        const allCoursesResp = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
          params: { wstoken: MOODLE_TOKEN, wsfunction: 'core_course_get_courses', moodlewsrestformat: 'json' }
        });
        const allCourses = Array.isArray(allCoursesResp.data) ? allCoursesResp.data : [];
        const match = allCourses.find((c: any) => c.shortname === courseId);
        if (match) moodleCourseId = match.id;
      } catch (e) { console.error("Error cursos:", e); }
    }

    // Obtener usuarios matriculados
    const enrolledResp = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
      params: { wstoken: MOODLE_TOKEN, wsfunction: 'core_enrol_get_enrolled_users', moodlewsrestformat: 'json', courseid: moodleCourseId }
    });
    const enrolledList: any[] = Array.isArray(enrolledResp.data) ? enrolledResp.data : [];

    const groupsByUsername = new Map<string, string>();
    const userIdToUsername = new Map<number, string>();

    // Mapeo de grupos...
    for (const u of enrolledList) {
      const uname = String(u?.username ?? '').toLowerCase().trim();
      if (u.id && uname) userIdToUsername.set(u.id, uname);
      let gname = 'Sin Grupo';
      const gs = Array.isArray(u?.groups) ? u.groups : [];
      if (gs.length > 0) gname = String(gs[0]?.name ?? 'Sin Grupo');
      if (uname) groupsByUsername.set(uname, gname);
    }

    // Obtener grupos profundos
    try {
      const groupsResp = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
        params: { wstoken: MOODLE_TOKEN, wsfunction: 'core_group_get_course_groups', moodlewsrestformat: 'json', courseid: moodleCourseId }
      });
      const courseGroups = Array.isArray(groupsResp.data) ? groupsResp.data : [];
      for (const grp of courseGroups) {
        const membersResp = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
          params: { wstoken: MOODLE_TOKEN, wsfunction: 'core_group_get_group_members', moodlewsrestformat: 'json', 'groupids[0]': grp.id }
        });
        const members = Array.isArray(membersResp.data) ? membersResp.data : [];
        for (const m of members) {
          const uname = userIdToUsername.get(m.userid);
          if (uname) groupsByUsername.set(uname, grp.name);
        }
      }
    } catch (errGroup) { console.warn("Warn grupos:", errGroup); }

    // Obtener Reporte de Logs
    const moodleResponse = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
      params: { wstoken: MOODLE_TOKEN, wsfunction: 'core_reportbuilder_retrieve_report', moodlewsrestformat: 'json', reportid: 18, perpage: 0 }
    });

    const raw = moodleResponse.data as any;
    const container = raw?.data ?? raw;
    const rows: any[] = Array.isArray(container?.rows) ? container.rows : [];

    // Estructuras
    type DayItem = { fecha: string; minutos: number; firstTs: number; lastTs: number; entrada?: string; salida?: string; };
    type UserAgg = { usuario: string; groupName: string; minutosTotales: number; diasDetalle: DayItem[] };
    const byUser = new Map<string, UserAgg>();

    // Inicializar usuarios
    groupsByUsername.forEach((groupName, username) => {
      byUser.set(username, { usuario: username, groupName: groupName, minutosTotales: 0, diasDetalle: [] });
    });

    const usernameIdx = 1;
    const courseShortIdx = 2;
    const durationIdx = 3;
    const dateIdx = 4;
    const courseShortnameVal = (req.query.courseShortname || courseId || '').toString().trim();

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
    const parseSpanishDate = (dateStr: string) => {
      if (!dateStr) return 0;
      const meses: { [key: string]: number } = { 'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5, 'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11 };
      try {
        const regex = /(\d{1,2})[\s\u00A0]+de[\s\u00A0]+([a-zA-Zñ]+)[\s\u00A0]+de[\s\u00A0]+(\d{4}),[\s\u00A0]+(\d{1,2}):(\d{2})/;
        const match = dateStr.toLowerCase().match(regex);
        if (match) {
          const dia = parseInt(match[1]); const mesNombre = match[2]; const anio = parseInt(match[3]); const hora = parseInt(match[4]); const min = parseInt(match[5]);
          const mesIndex = meses[mesNombre] ?? 0;
          return new Date(anio, mesIndex, dia, hora, min).getTime();
        }
      } catch (e) { }
      return 0;
    };

    for (const row of rows) {
      const cells = row.columns || [];
      const user = usernameIdx != null ? toText(cells[usernameIdx]).trim() : '';
      const courseVal = courseShortIdx != null ? toText(cells[courseShortIdx]).trim() : '';
      const durText = durationIdx != null ? toText(cells[durationIdx]) : '';

      const normMoodle = courseVal.toLowerCase();
      const normFront = courseShortnameVal.toLowerCase();
      if (!(normMoodle === normFront || normMoodle.includes(normFront) || normFront.includes(normMoodle))) continue;
      if (!user) continue;

      const userKey = user.toLowerCase();
      if (!byUser.has(userKey)) continue;

      const agg = byUser.get(userKey)!;

      // Fechas y Tiempos
      const sessionMinutes = parseDuration(durText);
      const dateTextRaw = dateIdx != null ? toText(cells[dateIdx]) : '';
      const startTimestamp = parseSpanishDate(dateTextRaw);

      if (startTimestamp > 0) {
        // Calculamos fin de sesión (Start + Duration)
        const endTimestamp = startTimestamp + (sessionMinutes * 60 * 1000);

        const d = new Date(startTimestamp);
        const fecha = d.toISOString().split('T')[0];

        // Buscar si ya existe el día
        const idx = agg.diasDetalle.findIndex((d) => d.fecha === fecha);

        if (idx >= 0) {
          // Actualizamos rangos: Buscamos la PRIMERA entrada y la ÚLTIMA salida real
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
      await collection.deleteMany({ courseId: courseId });
      const docsToInsert = out.map(item => ({
        ...item,
        courseId: courseId,
        courseShortname: courseShortnameVal || courseId,
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
    let allUsers = await col.find({ courseId: String(courseId) }).toArray();

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
        const nombre = (u.usuario || u.nombre || '').toLowerCase();
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
          nombre: user.usuario || user.nombre || 'Sin Nombre',
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
        row.getCell(2).value = (user.usuario || user.nombre || 'Sin Nombre').toUpperCase();

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

    const defaultMin = Number(courseInfo?.minMinutes || 170);
    const defaultSchedule = courseInfo?.scheduleTime || "00:00 - 23:59";
    const defaultStartDate = courseInfo?.startDate ? new Date(courseInfo.startDate) : null;
    const defaultEndDate = courseInfo?.endDate ? new Date(courseInfo.endDate) : null;

    let users = await col.find({ courseId: String(courseId) }).toArray();

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
        const nombre = (u.usuario || u.nombre || '').toLowerCase();
        return nombre.includes(q);
      });
    }

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
      const nombre = user.usuario || user.nombre || 'Sin Nombre';
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
    const response = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
      params: {
        wstoken: MOODLE_TOKEN,
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

    if (!MOODLE_URL || !MOODLE_TOKEN) {
      return res.status(500).json({ error: 'Configuración de Moodle incompleta (MOODLE_URL/MOODLE_TOKEN).' });
    }
    if (!reportid) {
      return res.status(400).json({ error: "Parámetro 'reportid' es requerido (?reportid=...)" });
    }

    const response = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
      params: {
        wstoken: MOODLE_TOKEN,
        wsfunction: 'core_reportbuilder_retrieve_report',
        moodlewsrestformat: 'json',
        reportid: reportid,
        perpage: 100
      }
    });

    if (response?.data && (response.data.exception || response.data.errorcode)) {
      return res.status(400).json(response.data);
    }

    return res.json(response.data); // JSON crudo de Moodle
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

    console.log(`🔎 Buscando curso manualmente: "${query}"...`);

    const response = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
      params: {
        wstoken: MOODLE_TOKEN,
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

    // Llamada a Moodle para traer TODOS los cursos
    const response = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
      params: {
        wstoken: MOODLE_TOKEN,
        wsfunction: 'core_course_get_courses',
        moodlewsrestformat: 'json'
      }
    });

    const allCourses = response.data || [];

    const listaLimpia = allCourses.map((c: any) => ({
      id: c.id,
      shortname: c.shortname,
      fullname: c.fullname
    }));

    res.json({ ok: true, cursos: listaLimpia });

  } catch (error) {
    console.error('Error al obtener cursos:', error);
    res.status(500).json({ ok: false, error: 'Error al conectar con Moodle' });
  }
});

// Obtener grupos de un curso específico
app.get('/api/groups/:courseId', async (req: any, res: any) => {
  try {
    const { courseId } = req.params;
    let foundCourse = null;

    if (!isNaN(Number(courseId))) {
      const idResp = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
        params: {
          wstoken: MOODLE_TOKEN,
          wsfunction: 'core_course_get_courses',
          moodlewsrestformat: 'json',
          'options[ids][0]': courseId
        }
      });
      if (idResp.data && idResp.data.length > 0) foundCourse = idResp.data[0];
    }

    if (!foundCourse) {
      const fieldResp = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
        params: {
          wstoken: MOODLE_TOKEN,
          wsfunction: 'core_course_get_courses_by_field',
          moodlewsrestformat: 'json',
          field: 'shortname',
          value: courseId
        }
      });
      if (fieldResp.data && fieldResp.data.courses && fieldResp.data.courses.length > 0) {
        foundCourse = fieldResp.data.courses[0];
      }
    }

    if (!foundCourse) {
      return res.json({ ok: false, error: 'Curso no encontrado en Moodle' });
    }

    const groupsResp = await axios.get(`${MOODLE_URL}/webservice/rest/server.php`, {
      params: {
        wstoken: MOODLE_TOKEN,
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
      const symbol = file.fileurl.includes('?') ? '&' : '?';
      finalImageUrl = `${file.fileurl}${symbol}token=${moodleToken}`;

      console.log("📸 FOTO GENERADA:", finalImageUrl);
    }

    // Buscar imagen incrustada en el HTML del resumen (Plan B)
    else if (moodleCourse.summary && moodleCourse.summary.includes('<img')) {
      const match = moodleCourse.summary.match(/src="([^"]+)"/);
      if (match) {
        finalImageUrl = match[1].replace('/pluginfile.php', `/webservice/pluginfile.php`);
        if (!finalImageUrl.includes('token=')) {
          finalImageUrl += `?token=${moodleToken}`;
        }
        console.log("📸 FOTO ENCONTRADA EN RESUMEN (HTML)");
      }
    } else {
      console.log("⚠️ No se encontró foto para este curso.");
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

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
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

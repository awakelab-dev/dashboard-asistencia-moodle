import { useEffect, useState } from 'react';
import axios from 'axios';
import { Form } from 'react-bootstrap';
import { CourseSelector } from './CourseSelector';


type DayRow = {
  day: string;
  startTime: string;
  endTime: string;
};

interface SettingsResponse {
  ok: boolean;
  exists: boolean;
  settings: {
    courseId: string;
    groupId: string;
    minMinutesPerDay: number;
    globalAttendancePercent: number;
    schedule: DayRow[];
  } | null;
}

export function AttendanceSettings() {
  const [courseId, setCourseId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [cursos, setCursos] = useState<any[]>([]);

  const [minMinutesPerDay, setMinMinutesPerDay] = useState<number | ''>('');
  const [globalAttendancePercent, setGlobalAttendancePercent] = useState<number | ''>('');

  const [schedule, setSchedule] = useState<DayRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gruposDisponibles, setGruposDisponibles] = useState<any[]>([]);

  useEffect(() => {
    const urlSinCache = `http://localhost:3000/api/courses?t=${Date.now()}`;
    axios.get(urlSinCache)
      .then(res => res.data.ok && setCursos(res.data.cursos))
      .catch(console.error);
  }, []);
  const handleAddDay = () => {
    setSchedule((prev) => [...prev, { day: '', startTime: '', endTime: '' }]);
  };

  const handleDayChange = (index: number, field: keyof DayRow, value: string) => {
    setSchedule((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  };

  // Cargar grupos cuando cambia el curso seleccionado
  useEffect(() => {
    if (!courseId) {
      setGruposDisponibles([]);
      return;
    }

    axios.get(`http://localhost:3000/api/groups/${courseId}`)
      .then(res => {
        if (res.data.ok && Array.isArray(res.data.groups)) {
          setGruposDisponibles(res.data.groups);
        } else {
          setGruposDisponibles([]);
        }
      })
      .catch(err => console.error("Error cargando grupos:", err));
  }, [courseId]);

  const handleRemoveDay = (index: number) => {
    setSchedule((prev) => prev.filter((_, i) => i !== index));
  };

  const handleLoad = async () => {
    if (!courseId || !groupId) {
      setError('Ingresa Course ID y Group ID antes de cargar.');
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const resp = await axios.get<SettingsResponse>('http://localhost:3000/api/attendance-settings', {
        params: { courseId, groupId },
      });

      if (resp.data.exists && resp.data.settings) {
        const s = resp.data.settings;
        setMinMinutesPerDay(s.minMinutesPerDay);
        setGlobalAttendancePercent(s.globalAttendancePercent);
        setSchedule(s.schedule || []);
        setMessage('Configuración cargada correctamente.');
      } else {
        // No hay config previa → dejamos limpio y avisamos
        setMinMinutesPerDay('');
        setGlobalAttendancePercent('');
        setSchedule([]);
        setMessage('No hay configuración previa para este curso y grupo. Puedes crearla.');
      }
    } catch (err) {
      console.error(err);
      setError('Error al cargar configuración.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!courseId || !groupId) {
      setError('Course ID y Group ID son obligatorios.');
      return;
    }
    if (minMinutesPerDay === '' || globalAttendancePercent === '') {
      setError('Debes indicar objetivo diario (minutos) y porcentaje global.');
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const body = {
        courseId,
        groupId,
        minMinutesPerDay: Number(minMinutesPerDay),
        globalAttendancePercent: Number(globalAttendancePercent),
        schedule,
      };

      const resp = await axios.post('http://localhost:3000/api/attendance-settings', body);
      if (resp.data?.ok) {
        setMessage('Configuración guardada correctamente.');
      } else {
        setError('No se pudo guardar la configuración.');
      }
    } catch (err) {
      console.error(err);
      setError('Error al guardar configuración.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="card card--full" aria-labelledby="settings-title">
      <header className="card__header">
        <i className="fa-solid fa-gear card__icon" aria-hidden="true"></i>
        <h2 id="settings-title" className="card__title">
          Parámetros de Asistencia por Grupo
        </h2>
      </header>

      <div className="card__body">
        <div className="form-grid form-grid--full">
          <div className="form-field">
            <label className="form-label">Curso</label>
            <div className="form-field">
              <CourseSelector
                courses={cursos}
                selectedValue={courseId}
                onChange={(val) => {
                  setCourseId(val);
                }}
                label="Curso (Buscador)"
              />
            </div>
          </div>

          <div className="form-field">
            <label className="form-label">Grupo</label>
            <Form.Select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              disabled={!courseId} // Deshabilitado si no hay curso
            >
              <option value="">-- Selecciona grupo --</option>

              {/* Opciones cargadas desde Moodle */}
              {gruposDisponibles.map((g) => (
                <option key={g.id} value={g.name}>
                  {g.name}
                </option>
              ))}

             
            </Form.Select>
          </div>

          <div className="form-field">
            <label htmlFor="set-minutes" className="form-label">
              Objetivo diario (minutos)
            </label>
            <input
              id="set-minutes"
              type="number"
              className="input"
              min={1}
              value={minMinutesPerDay}
              onChange={(e) => setMinMinutesPerDay(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </div>

          <div className="form-field">
            <label htmlFor="set-percent" className="form-label">
              Umbral de asistencia global (%)
            </label>
            <input
              id="set-percent"
              type="number"
              className="input"
              min={0}
              max={100}
              value={globalAttendancePercent}
              onChange={(e) => setGlobalAttendancePercent(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </div>

          <div className="form-actions form-actions--end">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleLoad}
              disabled={loading || saving}
            >
              {loading ? 'Cargando...' : 'Cargar configuración'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleSave}
              disabled={saving || loading}
            >
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>

        {error && <p className="error-msg" style={{ marginTop: '0.5rem' }}>{error}</p>}
        {message && <p className="success-msg" style={{ marginTop: '0.5rem', color: '#059669' }}>{message}</p>}

        <hr style={{ margin: '1.5rem 0' }} />

        <h3 style={{ marginBottom: '0.5rem' }}>Horarios por día (opcional)</h3>
        <p style={{ marginBottom: '0.75rem', fontSize: '0.9rem', color: '#4b5563' }}>
          Puedes agregar uno o varios días con su hora de inicio y fin. Si todos los días son iguales,
          basta con que repitas la fila cambiando el nombre del día.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {schedule.map((row, index) => (
            <div
              key={index}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 1fr 1fr auto',
                gap: '0.5rem',
                alignItems: 'center',
              }}
            >
              <input
                type="text"
                className="input"
                placeholder="Día (Lunes, Martes, ...)"
                value={row.day}
                onChange={(e) => handleDayChange(index, 'day', e.target.value)}
              />
              <input
                type="time"
                className="input"
                value={row.startTime}
                onChange={(e) => handleDayChange(index, 'startTime', e.target.value)}
              />
              <input
                type="time"
                className="input"
                value={row.endTime}
                onChange={(e) => handleDayChange(index, 'endTime', e.target.value)}
              />
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => handleRemoveDay(index)}
              >
                <i className="fa-solid fa-trash" aria-hidden="true"></i>
              </button>
            </div>
          ))}

          <button type="button" className="btn btn--secondary" onClick={handleAddDay}>
            <i className="fa-solid fa-plus" aria-hidden="true"></i>
            Agregar día
          </button>
        </div>
      </div>
    </article>
  );
}

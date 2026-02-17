import { useState, useEffect } from 'react';
import axios from 'axios';
import { Modal, Button, ProgressBar, Form, Badge } from 'react-bootstrap';
import { CourseSelector } from './CourseSelector';
interface AsistenciaData {
  tiempoTexto: string;
  horaEntrada: string;
  horaSalida: string;
}

export function ConsultaAsistencia() {
  const [courseId, setCourseId] = useState('');
  const [userId, setUserId] = useState('');
  const [data, setData] = useState<AsistenciaData | null>(null);

  // Estados de carga separados
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [loadingSync, setLoadingSync] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Estados para sync masivo
  const [cursosDisponibles, setCursosDisponibles] = useState<any[]>([]);
  const [seleccionados, setSeleccionados] = useState<string[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [filtro, setFiltro] = useState('');

  useEffect(() => {
    const urlSinCache = `http://localhost:3000/api/courses?t=${Date.now()}`;
    // Cargamos los cursos
    axios.get(urlSinCache)
      .then(res => {
        if (res.data.ok) {
          setCursosDisponibles(res.data.cursos);
          setSeleccionados([]);
        }
      })
      .catch(err => console.error(err));
  }, []);

  const cursosFiltrados = cursosDisponibles.filter(c =>
    c.shortname.toLowerCase().includes(filtro.toLowerCase()) ||
    c.fullname.toLowerCase().includes(filtro.toLowerCase())
  );

  // Manejadores de checks...
  const toggleCurso = (shortname: string) => {
    if (seleccionados.includes(shortname)) {
      setSeleccionados(prev => prev.filter(s => s !== shortname));
    } else {
      setSeleccionados(prev => [...prev, shortname]);
    }
  };

  const toggleSelectAllVisible = () => {
    // Solo selecciona/deselecciona lo que estás viendo (filtrado)
    const idsVisibles = cursosFiltrados.map(c => c.shortname);
    const todosMarcados = idsVisibles.every(id => seleccionados.includes(id));

    if (todosMarcados) {
      setSeleccionados(prev => prev.filter(id => !idsVisibles.includes(id)));
    } else {
      // Agregamos los que faltan
      const nuevos = idsVisibles.filter(id => !seleccionados.includes(id));
      setSeleccionados(prev => [...prev, ...nuevos]);
    }
  };

  // 1. Función para sincronización masiva
  const runSync = async () => {
    setIsSyncing(true);
    setProgress(0);
    setLogs([]);
    const total = seleccionados.length;
    let completed = 0;

    for (const shortname of seleccionados) {
      setLogs(prev => [`⏳ Procesando: ${shortname}...`, ...prev]);
      try {
        await axios.get(`http://localhost:3000/api/dailystats/${shortname}`);
        setLogs(prev => [`✅ ${shortname} OK`, ...prev]);
      } catch (err) {
        setLogs(prev => [`❌ Error en ${shortname}`, ...prev]);
      }
      completed++;
      setProgress(Math.round((completed / total) * 100));
    }
    setIsSyncing(false);
    setLogs(prev => [`✨ Fin del proceso`, ...prev]);
  };

  // 2. Función para Buscar (Consulta rápida)
  const handleSearch = async () => {
    if (!courseId) return;
    setLoadingSearch(true);
    setError('');
    setSuccessMsg('');
    setData(null);

    try {
      // Consulta rápida de totales
      const response = await axios.get(`http://localhost:3000/api/stats/${courseId}`, {
        params: { userId }
      });

      if (response.data && response.data.ok) {
        setData(response.data.asistencia);
      } else {
        setError('No se encontraron datos para este usuario.');
      }
    } catch (err) {
      setError('Error al consultar datos.');
    } finally {
      setLoadingSearch(false);
    }
  };

  // 3. Función para sincronizar un curso
  const handleSync = async () => {
    if (!courseId) {
      setError('Escribe el ID del Curso para sincronizar.');
      return;
    }
    setLoadingSync(true);
    setError('');
    setSuccessMsg('');

    try {
      const response = await axios.get(`http://localhost:3000/api/dailystats/${courseId}`);

      if (response.data && response.data.ok) {
        setSuccessMsg(`✅ Datos sincronizados correctamente (${response.data.data?.length || 0} usuarios procesados). Ya puedes descargar los reportes.`);
      } else {
        setError('La sincronización no devolvió confirmación.');
      }
    } catch (err: any) {
      console.error(err);
      setError('Error al conectar con Moodle. Revisa la consola del servidor.');
    } finally {
      setLoadingSync(false);
    }
  };

  return (
    <article className="card card--full" aria-labelledby="query-title" style={{ overflow: 'visible' }}>
      <header className="card__header">
        <i className="fa-solid fa-magnifying-glass card__icon" aria-hidden="true"></i>
        <h2 id="query-title" className="card__title">Consulta y Sincronización</h2>
      </header>
      <div className="card__body">
        <div className="form-grid form-grid--full">
          <div className="form-field">
            <label className="form-label">Curso</label>
            <CourseSelector 
                courses={cursosDisponibles}
                selectedValue={courseId}
                onChange={(val) => setCourseId(val)}
                label="Curso (Buscador)"
                disabled={loadingSync || loadingSearch}
            />
          </div>
          <div className="form-field">
            <label htmlFor="q-user" className="form-label">Usuario (Email/Nombre)</label>
            <input
              id="q-user" type="text" className="input" placeholder="Solo para buscar individual"
              value={userId} onChange={(e) => setUserId(e.target.value)}
            />
          </div>

          <div className="form-actions form-actions--end" style={{ gap: '10px' }}>
            {/* Botón Sincronizar */}
            <button
              type="button"
              className="btn"
              style={{ backgroundColor: '#10b981', color: 'white' }}
              onClick={handleSync}
              disabled={loadingSync || loadingSearch}
            >
              <i className={`fa-solid ${loadingSync ? 'fa-spinner fa-spin' : 'fa-rotate'}`} aria-hidden="true"></i>
              {loadingSync ? 'Sincronizando...' : 'Sincronizar Moodle'}
            </button>
            {/* Botón sync masivo  */}
            <button
              type="button"
              className="btn btn-dark"
              onClick={() => setShowModal(true)}
              title="Abrir panel de sincronización masiva"
            >
              <i className="fa-solid fa-layer-group"></i>
              Sync Masivo
              {cursosDisponibles.length > 0 && (
                <span style={{
                  background: 'rgba(255,255,255,0.2)',
                  padding: '2px 6px',
                  borderRadius: '10px',
                  fontSize: '0.75rem',
                  marginLeft: '8px'
                }}>
                  {cursosDisponibles.length}
                </span>
              )}
            </button>
            {/* Botón Buscar */}
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleSearch}
              disabled={loadingSearch || loadingSync}
            >
              <i className="fa-solid fa-search" aria-hidden="true"></i>
              {loadingSearch ? 'Buscando...' : 'Buscar'}
            </button>
          </div>
        </div>

        {error && <p className="error-msg">{error}</p>}
        {successMsg && <p style={{ color: '#10b981', marginTop: '0.5rem', fontWeight: 500 }}>{successMsg}</p>}

        {data && (
          <div style={{ marginTop: '1.5rem', background: '#f9fafb', padding: '1rem', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
            <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem', color: '#1f2937' }}>Resultados de {userId || 'Usuario'}:</h3>
            <p style={{ margin: '0.25rem 0' }}><strong>Tiempo Total Acumulado:</strong> {data.tiempoTexto}</p>
            <p style={{ margin: '0.25rem 0' }}><strong>Hora Entrada (aprox):</strong> {data.horaEntrada}</p>
            <p style={{ margin: '0.25rem 0' }}><strong>Hora Salida (aprox):</strong> {data.horaSalida}</p>
          </div>
        )}
      </div>

      {/* --- MODAL DE PROGRESO --- */}
      <Modal show={showModal} onHide={() => !isSyncing && setShowModal(false)} size="lg" centered scrollable>
        <Modal.Header closeButton={!isSyncing}>
          <Modal.Title>Sincronización Masiva</Modal.Title>
        </Modal.Header>

        <Modal.Body>
          {!isSyncing ? (
            <div className="d-flex flex-column h-100">

              {/* BARRA DE BÚSQUEDA */}
              <div className="mb-3">
                <Form.Control
                  type="text"
                  placeholder="🔍 Buscar curso por nombre o código..."
                  value={filtro}
                  onChange={(e) => setFiltro(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="d-flex justify-content-between align-items-center mb-2">
                <small className="text-muted">
                  Mostrando {cursosFiltrados.length} de {cursosDisponibles.length} cursos
                </small>
                <Button variant="outline-primary" size="sm" onClick={toggleSelectAllVisible}>
                  {cursosFiltrados.every(c => seleccionados.includes(c.shortname)) && cursosFiltrados.length > 0
                    ? 'Desmarcar Visibles'
                    : 'Marcar Visibles'}
                </Button>
              </div>

              {/* LISTA CON SCROLL */}
              <div style={{ flex: 1, minHeight: '300px', border: '1px solid #e9ecef', borderRadius: '8px', padding: '10px', overflowY: 'auto' }}>
                {cursosFiltrados.length > 0 ? (
                  cursosFiltrados.map(c => (
                    <Form.Check
                      key={c.id}
                      type="checkbox"
                      id={`check-${c.id}`}
                      label={
                        <span>
                          <strong>{c.shortname}</strong> <span className="text-muted small">- {c.fullname}</span>
                        </span>
                      }
                      checked={seleccionados.includes(c.shortname)}
                      onChange={() => toggleCurso(c.shortname)}
                      className="mb-2"
                    />
                  ))
                ) : (
                  <div className="text-center text-muted mt-5">
                    No se encontraron cursos con "{filtro}"
                  </div>
                )}
              </div>

              <div className="mt-2 text-end">
                <strong>{seleccionados.length}</strong> cursos seleccionados para procesar.
              </div>
            </div>
          ) : (
            // VISTA PROGRESO
            <div>
              <h5 className="text-center mb-3">Sincronizando... {progress}%</h5>
              <ProgressBar now={progress} animated variant="success" className="mb-4" />
              <div style={{ background: '#1e1e1e', color: '#00ff00', padding: '10px', height: '250px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px', borderRadius: '5px' }}>
                {logs.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </div>
          )}
        </Modal.Body>

        <Modal.Footer>
          {!isSyncing && (
            <>
              <Button variant="secondary" onClick={() => setShowModal(false)}>Cancelar</Button>
              <Button
                variant="primary"
                onClick={runSync}
                disabled={seleccionados.length === 0}
              >
                {seleccionados.length > 0 ? `Sincronizar (${seleccionados.length})` : 'Selecciona cursos'}
              </Button>
            </>
          )}
        </Modal.Footer>
      </Modal>
    </article>
  );
}
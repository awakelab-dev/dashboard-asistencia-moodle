import { useState, useEffect } from 'react';
import axios from 'axios';
import { Form, Button, Row, Col, Card, Alert, Table, Badge, Spinner } from 'react-bootstrap';

interface ReportesViewProps {
  courseData: any;
  onBack: () => void;
}

export function ReportesView({ courseData, onBack }: ReportesViewProps) {
  const [tipoReporte, setTipoReporte] = useState<'diario' | 'semanal'>('semanal');

  // Datos
  const [grupos, setGrupos] = useState<any[]>([]);
  const [grupoSeleccionado, setGrupoSeleccionado] = useState('');

  // Fechas
  const [fechaInicio, setFechaInicio] = useState('');
  const [fechaFin, setFechaFin] = useState('');
  const [fechaDia, setFechaDia] = useState('');

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [vistaPreviaData, setVistaPreviaData] = useState<any[]>([]);
  const [mensaje, setMensaje] = useState('');

  const objetivoDiario = Number(courseData.minMinutes || 170);
  const [userSearch, setUserSearch] = useState('');

  // SINCRONIZAR DATOS DESDE MOODLE
  const handleSyncMoodle = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      await axios.get(`/api/dailystats/${courseData.courseId}`, {
        params: { courseShortname: courseData.shortname }
      });
      setSyncMsg('✅ Datos sincronizados correctamente.');
      setTimeout(() => setSyncMsg(''), 4000);
    } catch (err: any) {
      const detalle = err?.response?.data?.detalle || err?.response?.data?.error || err?.message;
      setSyncMsg(`❌ Error al sincronizar${detalle ? `: ${detalle}` : ''}`);
    } finally {
      setSyncing(false);
    }
  };

  // 1. CARGAR GRUPOS AL INICIAR
  useEffect(() => {
    if (!courseData || !courseData.courseId) return;

    const cargarGrupos = async () => {
      try {
        const url = `/api/groups/${courseData.courseId}`;
        const res = await axios.get(url);

        if (res.data.ok && Array.isArray(res.data.groups)) {
          setGrupos(res.data.groups);
        } else {
          setGrupos([]);
        }
      } catch (err) {
        console.error("Error cargando grupos:", err);
      }
    };
    cargarGrupos();
  }, [courseData]);

  useEffect(() => {
    setVistaPreviaData([]);
    setMensaje('');
  }, [tipoReporte]);

  // --- LÓGICA DE FECHAS ---
  const handleFechaInicioChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val) return;
    const [y, m, d] = val.split('-').map(Number);
    const selectedDate = new Date(y, m - 1, d, 12, 0, 0);
    const day = selectedDate.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const lunes = new Date(selectedDate);
    lunes.setDate(selectedDate.getDate() + diffToMonday);
    const domingo = new Date(lunes);
    domingo.setDate(lunes.getDate() + 6);
    const fmt = (date: Date) => date.toISOString().split('T')[0];
    setFechaInicio(fmt(lunes));
    setFechaFin(fmt(domingo));
  };

  // --- GENERAR REPORTE ---
  const handleGenerarVista = async () => {
    if (tipoReporte === 'semanal' && !fechaInicio) return alert("Selecciona una fecha de inicio");
    if (tipoReporte === 'diario' && !fechaDia) return alert("Selecciona la fecha del reporte");

    setLoading(true);
    setMensaje('');
    setVistaPreviaData([]);

    try {
      const endpoint = tipoReporte === 'diario'
        ? '/api/reports/daily-export'
        : '/api/reports/weekly-export';

      const params: any = { courseId: courseData.courseId, format: 'json' };

      if (tipoReporte === 'diario') params.date = fechaDia;
      else { params.startDate = fechaInicio; params.endDate = fechaFin; }

      if (grupoSeleccionado) params.groupId = grupoSeleccionado;
      if (userSearch) params.userQuery = userSearch;

      const res = await axios.get(endpoint, { params });

      if (res.data.ok) {
        setVistaPreviaData(res.data.data);
        setMensaje(`✅ Se encontraron ${res.data.data.length} registros.`);
      } else {
        setMensaje('⚠️ No se encontraron datos.');
      }
    } catch (err) {
      console.error(err);
      setMensaje('❌ Error al conectar con el servidor.');
    } finally {
      setLoading(false);
    }
  };

  const handleDescargarReal = () => {
    let url = tipoReporte === 'diario'
      ? '/api/reports/daily-export?'
      : '/api/reports/weekly-export?';

    const params = new URLSearchParams({ courseId: courseData.courseId });
    if (grupoSeleccionado) params.append('groupId', grupoSeleccionado);
    if (userSearch) params.append('userQuery', userSearch);
    if (tipoReporte === 'diario') params.append('date', fechaDia);
    else { params.append('startDate', fechaInicio); params.append('endDate', fechaFin); }

    window.open(url + params.toString(), '_blank');
  };

  //HELPER PARA COLOREAR MINUTOS Y FERIADOS 
  const renderMinutos = (minutos: number) => {
    // CASO FERIADO (-1 viene del backend)
    if (minutos === -1) {
      return (
        <div style={{ backgroundColor: '#e9ecef', borderRadius: '4px', padding: '2px 0' }}>
          <span className="text-muted small fw-bold">X</span>
        </div>
      );
    }

    if (!minutos || minutos === 0) return <span className="text-muted small">-</span>;

    const color = minutos >= objetivoDiario ? '#198754' : '#fd7e14';
    return <span className="fw-bold" style={{ color: color }}>{minutos}m</span>;
  };

  return (
    <div className="animate__animated animate__fadeIn">

      {/* HEADER */}
      <div className="rounded-3 shadow-sm mb-4 position-relative overflow-hidden" style={{ background: 'white', minHeight: '120px', border: '1px solid #e5e7eb' }}>
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundImage: courseData.imageUrl ? `url(${courseData.imageUrl})` : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          backgroundSize: 'cover', backgroundPosition: 'center', filter: 'blur(10px) brightness(0.6)', transform: 'scale(1.1)', zIndex: 0
        }}></div>
        <div className="position-relative d-flex align-items-center justify-content-between p-4" style={{ zIndex: 1, height: '100%' }}>
          <div className="d-flex align-items-center gap-3">
            <Button variant="light" className="rounded-circle shadow" onClick={onBack} style={{ width: '45px', height: '45px' }}><i className="fa-solid fa-arrow-left text-dark"></i></Button>
            <div className="text-white">
              <Badge bg="info" className="mb-1 text-dark">{courseData.shortname}</Badge>
              <h2 className="m-0 fw-bold text-shadow">{courseData.fullname}</h2>
            </div>
          </div>
          <div className="d-flex align-items-center gap-3">
            <div className="d-none d-md-block text-white text-end opacity-75">
              <div className="small"><i className="fa-solid fa-users me-1"></i> Grupos: {grupos.length}</div>
              <div className="small"><i className="fa-regular fa-clock me-1"></i> Obj: {objetivoDiario}m</div>
            </div>
            <Button
              variant="light"
              size="sm"
              className="rounded-pill shadow-sm fw-bold"
              onClick={handleSyncMoodle}
              disabled={syncing}
              title="Sincronizar datos desde Moodle"
            >
              {syncing
                ? <><Spinner as="span" animation="border" size="sm" className="me-1" />Sincronizando...</>
                : <><i className="fa-solid fa-rotate me-1"></i>Sincronizar</>
              }
            </Button>
          </div>
        </div>
      </div>

      {/* MENSAJE SYNC */}
      {syncMsg && <Alert variant={syncMsg.includes('✅') ? 'success' : 'danger'} className="mx-3 mb-2" dismissible onClose={() => setSyncMsg('')}>{syncMsg}</Alert>}

      {/* CONTROLES */}
      <Card className="mb-4 shadow-sm border-0" style={{ marginTop: '-30px', marginLeft: '15px', position: 'relative', zIndex: 10 }}>
        <Card.Body>
          <Row className="align-items-end g-3">
            <Col md={3}>
              <div className="btn-group w-100" role="group">
                <input type="radio" className="btn-check" name="btnradio" id="btnradio1" checked={tipoReporte === 'semanal'} onChange={() => setTipoReporte('semanal')} />
                <label className="btn btn-outline-primary" htmlFor="btnradio1">📅 Semanal</label>
                <input type="radio" className="btn-check" name="btnradio" id="btnradio2" checked={tipoReporte === 'diario'} onChange={() => setTipoReporte('diario')} />
                <label className="btn btn-outline-primary" htmlFor="btnradio2">📆 Diario</label>
              </div>
            </Col>
            <Col md={2}>
              <Form.Label className="small fw-bold text-muted mb-1">Filtrar Grupo</Form.Label>
              <Form.Select size="sm" value={grupoSeleccionado} onChange={(e) => setGrupoSeleccionado(e.target.value)} disabled={grupos.length === 0}>
                <option value="">-- Todos los estudiantes --</option>
                {grupos.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Form.Select>
            </Col>
            <Col md={2}>
              <Form.Label className="small fw-bold text-muted mb-1">Buscar Estudiante</Form.Label>
              <Form.Control
                type="text"
                size="sm"
                placeholder="Nombre..."
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
              />
            </Col>
            {tipoReporte === 'semanal' ? (
              <Col md={2}>
                <Form.Label className="small fw-bold text-muted mb-1">Semana (Lunes)</Form.Label>
                <Form.Control type="date" size="sm" value={fechaInicio} onChange={handleFechaInicioChange} />
              </Col>
            ) : (
              <Col md={2}>
                <Form.Label className="small fw-bold text-muted mb-1">Fecha Reporte</Form.Label>
                <Form.Control type="date" size="sm" value={fechaDia} onChange={(e) => setFechaDia(e.target.value)} />
              </Col>
            )}
            <Col md={2}>
              <Button variant="primary" className="w-100" onClick={handleGenerarVista} disabled={loading}>
                {loading ? <Spinner as="span" animation="border" size="sm" /> : 'Ver Informe'}
              </Button>
            </Col>
          </Row>
        </Card.Body>
      </Card>

      {/* TABLA */}
      {mensaje && <Alert variant={mensaje.includes('✅') ? 'success' : 'warning'} className="mx-3">{mensaje}</Alert>}

      {vistaPreviaData.length > 0 && (
        <div className="px-3 pb-5 animate__animated animate__fadeInUp">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h5 className="m-0 fw-bold text-secondary"><i className="fa-solid fa-table-list me-2"></i>Resultados</h5>
            <Button variant="success" size="sm" onClick={handleDescargarReal}><i className="fa-solid fa-file-excel me-2"></i> Descargar Excel</Button>
          </div>

          <div className="border rounded shadow-sm bg-white overflow-hidden">
            <Table hover responsive className="mb-0 align-middle">
              <thead className="bg-light text-secondary small text-uppercase">
                <tr>
                  <th className="py-3 px-3">Estudiante</th>
                  <th className="py-3 px-3">Grupo</th>
                  {tipoReporte === 'semanal' ? (
                    <>
                      <th className="text-center">Lun</th><th className="text-center">Mar</th>
                      <th className="text-center">Mié</th><th className="text-center">Jue</th><th className="text-center">Vie</th>
                    </>
                  ) : (
                    <>
                      <th className="text-center">Fecha</th><th className="text-center">Entrada</th><th className="text-center">Salida</th><th className="text-center">Minutos</th>
                    </>
                  )}
                  <th className="text-center">Estado</th>
                </tr>
              </thead>
              <tbody>
                {vistaPreviaData.map((row, idx) => {
                  return (
                    <tr key={idx} style={{ fontSize: '0.95rem' }}>
                      <td className="px-3 fw-500">{row.nombre}</td>
                      <td className="px-3"><Badge bg="light" text="dark" className="border fw-normal">{row.grupo}</Badge></td>

                      {tipoReporte === 'semanal' ? (
                        <>
                          <td className="text-center">{renderMinutos(row.Lunes)}</td>
                          <td className="text-center">{renderMinutos(row.Martes)}</td>
                          <td className="text-center">{renderMinutos(row.Miércoles)}</td>
                          <td className="text-center">{renderMinutos(row.Jueves)}</td>
                          <td className="text-center">{renderMinutos(row.Viernes)}</td>
                        </>
                      ) : (
                        <>
                          <td className="text-center text-muted small">{row.fecha}</td>
                          <td className="text-center small">{row.entrada || '--:--'}</td>
                          <td className="text-center small">{row.salida || '--:--'}</td>
                          <td className="text-center fw-bold text-dark">{row.minutos}m</td>
                        </>
                      )}

                      <td className="text-center">
                        {row.estado ? (
                          row.estado === 'APTO' ? (
                            <Badge bg="success" className="px-2 py-1">
                              <i className="fa-solid fa-check me-1"></i>Cumplió
                            </Badge>
                          ) : row.estado === 'NO APTO' ? (
                            <span
                              className="badge px-2 py-1"
                              style={{
                                backgroundColor: '#fd7e14',
                                color: 'white',
                                fontSize: '0.75em'
                              }}
                            >
                              <i className="fa-solid fa-xmark me-1"></i>No cumplió
                            </span>
                          ) : (
                            // Fallback para otros estados (N/A)
                            <Badge bg="secondary" className="px-2 py-1">{row.estado}</Badge>
                          )
                        ) : (
                          (tipoReporte === 'diario' && row.cumple === 'SI')
                            ? <Badge bg="success-subtle" text="success" className="px-2 py-1"><i className="fa-solid fa-check"></i> Cumple</Badge>
                            : <Badge bg="warning-subtle" text="warning" className="px-2 py-1"><i className="fa-solid fa-triangle-exclamation"></i> Pendiente</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
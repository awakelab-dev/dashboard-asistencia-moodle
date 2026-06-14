import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Modal, Button, Form, Table, Spinner, Alert, Badge } from 'react-bootstrap';

interface MoodleCourse {
    id: number;
    shortname: string;
    fullname: string;
}

interface EnrolRule {
    id: number;
    sourcecourseid: number;
    sourcecoursename: string;
    roleid: number;
    status: number;
}

interface ConditionalEnrolModalProps {
    show: boolean;
    onHide: () => void;
    destCourse: { courseId: number; shortname: string; fullname: string } | null;
}

export function ConditionalEnrolModal({ show, onHide, destCourse }: ConditionalEnrolModalProps) {
    const [moodleCourses, setMoodleCourses] = useState<MoodleCourse[]>([]);
    const [rules, setRules] = useState<EnrolRule[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);

    // Form states
    const [sourceCourseId, setSourceCourseId] = useState<number | ''>('');
    const [roleId] = useState<number>(5); // Default: student
    const [error, setError] = useState('');

    // Course search
    const [searchQuery, setSearchQuery] = useState('');
    const [showDropdown, setShowDropdown] = useState(false);
    const searchRef = useRef<HTMLDivElement>(null);

    const filteredCourses = moodleCourses.filter(c =>
        c.shortname.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.fullname.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const selectedCourse = moodleCourses.find(c => c.id === Number(sourceCourseId));

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
                setShowDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (show && destCourse) {
            loadInitialData();
        }
    }, [show, destCourse]);

    const loadInitialData = async () => {
        setLoading(true);
        setError('');
        try {
            const [coursesRes, rulesRes] = await Promise.all([
                axios.get('/api/moodle/courses', {
                    params: { courseId: destCourse?.courseId }
                }),
                axios.get(`/api/moodle/conditional-rules/${destCourse?.courseId}`)
            ]);

            if (coursesRes.data.ok) setMoodleCourses(coursesRes.data.courses);
            if (rulesRes.data.ok) setRules(rulesRes.data.rules);
        } catch (err: any) {
            console.error('Error cargando datos:', err);
            const msg = err.response?.data?.error || err.message || 'Error desconocido';
            setError(`Error: ${msg}`);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!sourceCourseId || !destCourse) return;

        // Check if rule already exists
        if (rules.some(r => r.sourcecourseid === Number(sourceCourseId))) {
            setError('Ya existe una regla para este curso origen.');
            return;
        }

        setSaving(true);
        setError('');
        try {
            const res = await axios.post('/api/moodle/conditional-rules', {
                courseId: destCourse.courseId,
                sourceCourseId,
                roleId
            });

            if (res.data.ok) {
                // Refresh rules
                const rulesRes = await axios.get(`/api/moodle/conditional-rules/${destCourse.courseId}`);
                if (rulesRes.data.ok) setRules(rulesRes.data.rules);
                setSourceCourseId('');
                setSearchQuery('');
            }
        } catch (err: any) {
            const msg = err.response?.data?.error || err.message || 'Error desconocido';
            setError(`Error al guardar: ${msg}`);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (instanceId: number) => {
        if (!destCourse) return;
        setDeletingId(instanceId);
        try {
            const res = await axios.delete(`/api/moodle/conditional-rules/${instanceId}`, {
                params: { courseId: destCourse.courseId }
            });
            if (res.data.ok) {
                setRules(prev => prev.filter(r => r.id !== instanceId));
            }
        } catch (err: any) {
            const msg = err.response?.data?.error || err.message || 'Error desconocido';
            setError(`Error al eliminar: ${msg}`);
        } finally {
            setDeletingId(null);
        }
    };


    return (
        <Modal show={show} onHide={onHide} size="lg" centered backdrop="static" className="fade-in-up">
            <Modal.Header closeButton style={{ background: 'var(--brand-gradient)', border: 'none' }} className="py-4">
                <Modal.Title className="text-white d-flex align-items-center" style={{ fontSize: '1.25rem', fontWeight: 700, letterSpacing: '-0.5px' }}>
                    <div className="bg-white bg-opacity-25 rounded-circle p-2 d-flex align-items-center justify-content-center me-3" style={{ width: '42px', height: '42px' }}>
                        <i className="fa-solid fa-diagram-project text-white"></i>
                    </div>
                    <div>
                        <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', opacity: 0.8, fontWeight: 600, marginBottom: '-2px' }}>Automatización Moodle</div>
                        Reglas Condicionales &rarr; {destCourse?.shortname}
                    </div>
                </Modal.Title>
            </Modal.Header>

            <Modal.Body className="p-4">
                {error && <Alert variant="danger" dismissible onClose={() => setError('')}>{error}</Alert>}

                <div className="p-4 rounded-4 mb-4 border-0 shadow-sm" style={{ background: 'rgba(241, 245, 249, 0.5)', border: '1px solid #e2e8f0' }}>
                    <div className="d-flex align-items-center mb-3">
                        <div className="bg-success bg-opacity-10 text-success rounded-circle p-2 me-2" style={{ width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <i className="fa-solid fa-plus-circle" style={{ fontSize: '0.9rem' }}></i>
                        </div>
                        <h6 className="fw-bold m-0 text-dark" style={{ fontSize: '0.95rem' }}>Nueva Regla de Automatización</h6>
                    </div>

                    <Form.Group className="mb-2">
                        <Form.Label className="small fw-bold text-muted mb-2">CURSO ORIGEN (El alumno debe completar este curso primero):</Form.Label>
                        <div className="d-flex gap-3">
                            <div className="flex-grow-1 position-relative" ref={searchRef}>
                                <div className="input-group">
                                    <span className="input-group-text bg-white border-end-0" style={{ borderRadius: '8px 0 0 8px' }}>
                                        <i className="fa-solid fa-magnifying-glass text-muted" style={{ fontSize: '0.85rem' }}></i>
                                    </span>
                                    <Form.Control
                                        type="text"
                                        className="form-control-premium shadow-none border-start-0"
                                        style={{ borderRadius: '0 8px 8px 0' }}
                                        placeholder={selectedCourse ? `${selectedCourse.shortname} | ${selectedCourse.fullname.length > 50 ? selectedCourse.fullname.substring(0, 50) + '...' : selectedCourse.fullname}` : '-- Buscar y seleccionar curso --'}
                                        value={showDropdown ? searchQuery : (selectedCourse ? '' : '')}
                                        onChange={(e) => {
                                            setSearchQuery(e.target.value);
                                            setShowDropdown(true);
                                            if (e.target.value === '') setSourceCourseId('');
                                        }}
                                        onFocus={() => {
                                            setSearchQuery('');
                                            setShowDropdown(true);
                                        }}
                                        disabled={saving || loading}
                                    />
                                    {sourceCourseId && (
                                        <button
                                            type="button"
                                            className="btn btn-outline-secondary border-start-0"
                                            style={{ borderRadius: '0 8px 8px 0', marginLeft: '-1px' }}
                                            onClick={() => { setSourceCourseId(''); setSearchQuery(''); setShowDropdown(false); }}
                                            title="Limpiar selección"
                                        >
                                            <i className="fa-solid fa-xmark text-muted" style={{ fontSize: '0.8rem' }}></i>
                                        </button>
                                    )}
                                </div>

                                {showDropdown && (
                                    <div
                                        className="position-absolute w-100 bg-white border rounded-3 shadow-lg"
                                        style={{ zIndex: 9999, top: 'calc(100% + 4px)', maxHeight: '260px', overflowY: 'auto' }}
                                    >
                                        {loading ? (
                                            <div className="text-center py-3">
                                                <Spinner size="sm" animation="border" variant="secondary" />
                                            </div>
                                        ) : filteredCourses.length === 0 ? (
                                            <div className="px-3 py-2 text-muted small">No se encontraron cursos.</div>
                                        ) : (
                                            filteredCourses.map(c => (
                                                <div
                                                    key={c.id}
                                                    className="px-3 py-2 cursor-pointer"
                                                    style={{ cursor: 'pointer', borderBottom: '1px solid #f1f5f9', fontSize: '0.88rem' }}
                                                    onMouseEnter={e => (e.currentTarget.style.background = '#f0f7ff')}
                                                    onMouseLeave={e => (e.currentTarget.style.background = '')}
                                                    onMouseDown={() => {
                                                        setSourceCourseId(c.id);
                                                        setSearchQuery('');
                                                        setShowDropdown(false);
                                                    }}
                                                >
                                                    <span className="fw-semibold text-primary me-2">{c.shortname}</span>
                                                    <span className="text-dark">{c.fullname.length > 70 ? c.fullname.substring(0, 70) + '...' : c.fullname}</span>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>
                            <Button className="btn-premium px-4" onClick={handleSave} disabled={!sourceCourseId || saving}>
                                {saving ? <Spinner size="sm" animation="border" /> : <><i className="fa-solid fa-magic me-2"></i> Activar</>}
                            </Button>
                        </div>
                        <div className="mt-3 d-flex align-items-center text-muted" style={{ fontSize: '0.8rem' }}>
                            <i className="fa-solid fa-circle-info me-2 text-primary"></i>
                            La inscripción se ejecutará automáticamente en cuanto Moodle registre la finalización del curso origen.
                        </div>
                    </Form.Group>
                </div>

                <div className="d-flex justify-content-between align-items-center mb-3">
                    <h6 className="fw-bold m-0 text-dark d-flex align-items-center">
                        <i className="fa-solid fa-list-check me-2 text-muted"></i>
                        Reglas Activas en este Curso
                    </h6>
                    <Badge bg="light" className="text-dark border px-3 py-2 rounded-pill fw-normal">
                        {rules.length} {rules.length === 1 ? 'Regla' : 'Reglas'} vinculadas
                    </Badge>
                </div>
                {loading ? (
                    <div className="text-center py-4"><Spinner animation="border" variant="success" /></div>
                ) : rules.length === 0 ? (
                    <Alert variant="info" className="text-center">No hay reglas configuradas para este curso.</Alert>
                ) : (
                    <div className="table-container-premium">
                        <Table borderless responsive className="align-middle mb-0">
                            <thead>
                                <tr style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: '#64748b', borderBottom: '1px solid #f1f5f9' }}>
                                    <th className="pb-3 ps-2">Curso Origen Requisito</th>
                                    <th className="pb-3 text-center">Rol Asignado</th>
                                    <th className="pb-3 text-center">Estado</th>
                                    <th className="pb-3 text-end pe-2">Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rules.map(rule => (
                                    <tr key={rule.id} style={{ borderBottom: '1px solid #f8fafc' }} className="rule-row">
                                        <td className="py-3 ps-2">
                                            <div className="fw-bold text-dark" style={{ fontSize: '0.95rem' }}>{rule.sourcecoursename}</div>
                                            <div className="small text-muted d-flex align-items-center">
                                                <i className="fa-solid fa-fingerprint me-1" style={{ fontSize: '0.7rem' }}></i>
                                                Moodle ID: {rule.sourcecourseid}
                                            </div>
                                        </td>
                                        <td className="text-center">
                                            <Badge bg="white" className="text-primary border px-3 py-2 rounded-3 fw-medium" style={{ fontSize: '0.8rem' }}>
                                                <i className="fa-solid fa-user-graduate me-2"></i>
                                                {rule.roleid === 5 ? 'Estudiante' : 'ID: ' + rule.roleid}
                                            </Badge>
                                        </td>
                                        <td className="text-center">
                                            <Badge className={`badge-active ${rule.status !== 0 ? 'bg-danger' : ''}`}>
                                                <i className={`fa-solid ${rule.status === 0 ? 'fa-check-circle' : 'fa-pause-circle'} me-2`}></i>
                                                {rule.status === 0 ? 'Activa' : 'Pausa'}
                                            </Badge>
                                        </td>
                                        <td className="text-end pe-2">
                                            <Button
                                                variant="light"
                                                className="rounded-circle p-2 text-danger shadow-sm border"
                                                style={{ width: '36px', height: '36px', transition: 'all 0.2s' }}
                                                onClick={() => handleDelete(rule.id)}
                                                disabled={deletingId === rule.id}
                                            >
                                                {deletingId === rule.id ? <Spinner size="sm" animation="border" /> : <i className="fa-regular fa-trash-can icon-hover icon-delete-hover"></i>}
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </Table>
                    </div>
                )}
            </Modal.Body>
        </Modal>
    );
}

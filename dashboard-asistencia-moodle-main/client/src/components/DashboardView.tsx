import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Card, Button, Modal, Form, Badge, Row, Col, Spinner, Alert, Table } from 'react-bootstrap';
import { BulkEnrolModal } from './BulkEnrolModal';
import { ConditionalEnrolModal } from './ConditionalEnrolModal';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// --- INTERFACES ---
interface RegisteredCourse {
    _id: string;
    courseId: number;
    shortname: string;
    fullname: string;
    imageUrl?: string;
    minMinutes: number;
    globalThreshold: number;
    startDate?: string;
    endDate?: string;
    totalHours?: string;
    scheduleTime?: string;
    holidays?: string[];
    entityName?: string;
    cif?: string;
}
interface GroupSetting {
    _id?: string;
    courseId: string;
    groupId: string;
    groupName?: string;
    minMinutesPerDay: number;
    globalAttendancePercent: number;
    startDate?: string;
    endDate?: string;
    scheduleTime?: string;
    holidays?: string[];
}

const normalizeImageUrl = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    try {
        const u = new URL(url);
        if (u.pathname.startsWith('/api/proxy-img')) return u.pathname + u.search;
    } catch {}
    return url;
};

function SortableCard({ id, children, disabled }: { id: number; children: React.ReactNode; disabled?: boolean }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
    if (disabled) return <div>{children}</div>;
    return (
        <div
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                opacity: isDragging ? 0.4 : 1,
                cursor: isDragging ? 'grabbing' : 'grab',
                touchAction: 'none',
            }}
        >
            {children}
        </div>
    );
}

export function DashboardView({ onCourseSelect, role }: { onCourseSelect: (course: any) => void; role?: string }) {
    const isAdmin = role === 'admin';
    // ESTADOS PRINCIPALES
    const [courses, setCourses] = useState<RegisteredCourse[]>([]);

    // ESTADOS AGREGAR CURSO
    const [showAddModal, setShowAddModal] = useState(false);
    const [newUrl, setNewUrl] = useState('https://catalejodigital.com');
    const [newToken, setNewToken] = useState('');
    const [newId, setNewId] = useState('');
    const [loadingAdd, setLoadingAdd] = useState(false);
    const [newEntity, setNewEntity] = useState('Entidad de formación');
    const [newCif, setNewCif] = useState('A111111111');

    // ESTADO SINCRONIZACIÓN
    const [syncingId, setSyncingId] = useState<number | null>(null);

    // ESTADO ORDENAMIENTO
    const [syncingOrder, setSyncingOrder] = useState(false);
    const [showSyncOrderModal, setShowSyncOrderModal] = useState(false);
    const [parentCourseIdInput, setParentCourseIdInput] = useState('681');
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIndex = courses.findIndex(c => c.courseId === active.id);
        const newIndex = courses.findIndex(c => c.courseId === over.id);
        const reordered = arrayMove(courses, oldIndex, newIndex);
        setCourses(reordered);
        await axios.put('/api/courses/order', { order: reordered.map(c => c.courseId) });
    };

    const handleSyncOrderFromMoodle = async () => {
        if (!parentCourseIdInput) return;
        setSyncingOrder(true);
        try {
            const res = await axios.post('/api/courses/sync-order-from-moodle', {
                parentCourseId: Number(parentCourseIdInput)
            });
            if (res.data.ok) {
                alert(`✅ ${res.data.message}`);
                loadCourses();
                setShowSyncOrderModal(false);
            } else {
                alert(`❌ ${res.data.error}`);
            }
        } catch (e: any) {
            alert(`❌ ${e.response?.data?.error || e.message}`);
        } finally {
            setSyncingOrder(false);
        }
    };

    // GESTOR DE GRUPOS 
    const [showGroupsListModal, setShowGroupsListModal] = useState(false);
    const [selectedCourseForGroups, setSelectedCourseForGroups] = useState<RegisteredCourse | null>(null);
    const [configuredGroups, setConfiguredGroups] = useState<GroupSetting[]>([]);

    //ESTADOS CONFIGURACIÓN DE GRUPO
    const [availableMoodleGroups, setAvailableMoodleGroups] = useState<any[]>([]);
    const [editingGroup, setEditingGroup] = useState<GroupSetting | null>(null);

    // ESTADOS CONFIGURACIÓN GENERAL
    const [showConfigModal, setShowConfigModal] = useState(false);
    const [configCourse, setConfigCourse] = useState<RegisteredCourse | null>(null);
    const [tempMinutes, setTempMinutes] = useState<number | string>('');
    const [tempThreshold, setTempThreshold] = useState<number | string>('');
    const [tempTotalHours, setTempTotalHours] = useState('');
    const [tempSchedule, setTempSchedule] = useState('');
    const [savingConfig, setSavingConfig] = useState(false);

    // ESTADOS CALENDARIO
    const [showCalendarModal, setShowCalendarModal] = useState(false);
    const [tempHolidays, setTempHolidays] = useState<string[]>([]);

    // ESTADOS ELIMINAR
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [courseToDelete, setCourseToDelete] = useState<RegisteredCourse | null>(null);

    // ESTADOS INSCRIPCIÓN MASIVA
    const [showEnrolModal, setShowEnrolModal] = useState(false);
    const [enrolTargetCourse, setEnrolTargetCourse] = useState<RegisteredCourse | null>(null);
    const [showConditionalModal, setShowConditionalModal] = useState(false);
    const [conditionalTargetCourse, setConditionalTargetCourse] = useState<RegisteredCourse | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    // Variables temporales del formulario
    const [tempGroupId, setTempGroupId] = useState('');
    const [tempGroupName, setTempGroupName] = useState('');
    const [tempStartDate, setTempStartDate] = useState('');
    const [tempEndDate, setTempEndDate] = useState('');
    const normalizedTempGroupId = String(tempGroupId ?? '').trim();
    const selectedGroupExistsInOptions = availableMoodleGroups.some(
        g => String(g.id).trim() === normalizedTempGroupId
    );

    useEffect(() => {
        loadCourses();
    }, []);

    const loadCourses = () => {
        axios.get('/api/courses/list')
            .then(res => setCourses(res.data.courses || []))
            .catch(console.error);
    };

    const openConfigModal = (course: RegisteredCourse, e: React.MouseEvent) => {
        e.stopPropagation();
        setConfigCourse(course);
        setTempMinutes(course.minMinutes);
        setTempThreshold(course.globalThreshold);
        setTempTotalHours(course.totalHours || '30H');
        setTempSchedule(course.scheduleTime || '09:00 - 14:00');
        setTempHolidays(course.holidays || []);
        setShowConfigModal(true);
    };

    const handleSaveConfig = async () => {
        if (!configCourse) return;
        setSavingConfig(true);
        try {
            await axios.put('/api/courses/settings', {
                courseId: configCourse.courseId,
                minMinutes: tempMinutes,
                globalThreshold: tempThreshold,
                totalHours: tempTotalHours,
                scheduleTime: tempSchedule,
                holidays: tempHolidays
            });
            setCourses(prev => prev.map(c =>
                c.courseId === configCourse.courseId
                    ? { ...c, minMinutes: Number(tempMinutes), globalThreshold: Number(tempThreshold), totalHours: tempTotalHours, scheduleTime: tempSchedule, holidays: tempHolidays }
                    : c
            ));
            setShowConfigModal(false);
            setShowCalendarModal(false);
            alert("✅ Configuración guardada");
        } catch (error) {
            alert("Error al guardar");
        } finally {
            setSavingConfig(false);
        }
    };

    const renderCalendarMonths = () => {
        // Usamos las fechas que se están editando en el formulario
        const start = tempStartDate ? new Date(tempStartDate) : new Date();
        const end = tempEndDate ? new Date(tempEndDate) : new Date(new Date().setMonth(new Date().getMonth() + 3));

        const months = [];
        let current = new Date(start.getFullYear(), start.getMonth(), 1);
        const loopEnd = new Date(end.getFullYear(), end.getMonth(), 1);

        while (current <= loopEnd) {
            months.push(new Date(current));
            current.setMonth(current.getMonth() + 1);
        }

        return (
            <div className="d-flex flex-column gap-4">
                {months.map((monthDate, idx) => {
                    const year = monthDate.getFullYear();
                    const month = monthDate.getMonth();
                    const daysInMonth = new Date(year, month + 1, 0).getDate();
                    const firstDayIndex = new Date(year, month, 1).getDay();
                    const startDay = firstDayIndex === 0 ? 6 : firstDayIndex - 1;
                    const daysArray = Array.from({ length: daysInMonth }, (_, i) => i + 1);
                    const emptySlots = Array.from({ length: startDay }, (_, i) => i);
                    const monthName = monthDate.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }).toUpperCase();

                    return (
                        <div key={idx} className="border rounded p-2 bg-light">
                            <h6 className="fw-bold text-center mb-2 bg-warning text-dark py-1 rounded">{monthName}</h6>
                            <div className="d-flex text-center small fw-bold text-muted mb-1">
                                {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(d => <div key={d} style={{ width: '14.28%' }}>{d}</div>)}
                            </div>
                            <div className="d-flex flex-wrap">
                                {emptySlots.map(i => <div key={`empty-${i}`} style={{ width: '14.28%', height: '50px' }}></div>)}
                                {daysArray.map(day => {
                                    const dateObj = new Date(year, month, day);
                                    const dateStr = dateObj.toISOString().split('T')[0];
                                    const dayOfWeek = dateObj.getDay();
                                    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                                    const isHoliday = tempHolidays.includes(dateStr);
                                    const isLectivo = !isWeekend && !isHoliday;

                                    // Rango basado en las fechas del formulario
                                    const formStart = new Date(tempStartDate);
                                    const formEnd = new Date(tempEndDate);
                                    const isInRange = dateObj >= new Date(formStart.setHours(0, 0, 0, 0)) && dateObj <= new Date(formEnd.setHours(23, 59, 59, 999));

                                    let bgColor = !isInRange ? '#e9ecef' : isHoliday ? '#dc3545' : isWeekend ? '#6c757d' : '#92D050';
                                    let color = (isHoliday || isWeekend) ? 'white' : 'black';

                                    return (
                                        <div key={day} style={{
                                            width: '14.28%', height: '50px', border: '1px solid #dee2e6',
                                            backgroundColor: bgColor, cursor: isInRange ? 'pointer' : 'default',
                                            color: color, display: 'flex', flexDirection: 'column',
                                            justifyContent: 'center', alignItems: 'center', fontSize: '0.75rem'
                                        }}
                                            onClick={() => isInRange && toggleHoliday(dateStr)}
                                            title={isHoliday ? 'FERIADO' : 'LECTIVO'}
                                        >
                                            <span className="fw-bold">{day}</span>
                                            {isLectivo && isInRange && <span style={{ fontSize: '0.6rem' }}>{tempSchedule.split('-')[0] || 'Clase'}</span>}
                                            {isHoliday && <span style={{ fontSize: '0.6rem' }}>X</span>}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    };

    const confirmDelete = (course: RegisteredCourse, e: React.MouseEvent) => {
        e.stopPropagation();
        setCourseToDelete(course);
        setShowDeleteModal(true);
    };

    const handleDeleteCourse = async () => {
        if (!courseToDelete) return;
        setIsDeleting(true);
        try {
            await axios.delete(`/api/courses/${courseToDelete.courseId}`);
            setCourses(prev => prev.filter(c => c.courseId !== courseToDelete.courseId));
            setShowDeleteModal(false);
            setCourseToDelete(null);
        } catch (error) {
            console.error(error);
            alert("Error al eliminar el curso");
        } finally {
            setIsDeleting(false);
        }
    };


    const autoCalculateMinutes = (scheduleStr: string) => {
        if (!scheduleStr || !scheduleStr.includes('-')) return; // Corregido: antes decía .includes('170') que parecía un error
        try {
            const parts = scheduleStr.split('-');
            const startStr = parts[0].trim().replace('H', '');
            const endStr = parts[1].trim().replace('H', '');

            const toMinutes = (time: string) => {
                const [h, m] = time.split(':').map(Number);
                return (h * 60) + (m || 0);
            };

            const startMin = toMinutes(startStr);
            const endMin = toMinutes(endStr);

            if (!isNaN(startMin) && !isNaN(endMin)) {
                let diff = endMin - startMin;
                if (diff < 0) diff += 1440;
                if (diff > 0) setTempMinutes(diff);
            }
        } catch (e) {
            console.log("Formato de hora no válido para cálculo automático");
        }
    };

    const handleOpenGroupsManager = async (course: RegisteredCourse, e: React.MouseEvent) => {
        e.stopPropagation();
        setSelectedCourseForGroups(course);
        setShowGroupsListModal(true);
        loadConfiguredGroups(course.courseId);
    };

    const loadConfiguredGroups = async (courseId: number) => {
        try {
            const res = await axios.get(`/api/attendance-settings/all/${courseId}`);
            if (res.data.ok) {
                setConfiguredGroups(res.data.groups);
            }
        } catch (error) { console.error("Error cargando grupos", error); }
    };

    const handleDeleteGroup = async (grp: GroupSetting) => {
        if (!window.confirm(`¿Eliminar la configuración del grupo "${grp.groupName || grp.groupId}"?`)) return;
        try {
            await axios.delete(`/api/attendance-settings/${grp.courseId}/${grp.groupId}`);
            loadConfiguredGroups(Number(grp.courseId));
        } catch (error) { console.error("Error eliminando grupo", error); }
    };

    const handleOpenConfigModal = async (groupSetting: GroupSetting | null) => {
        if (!selectedCourseForGroups) return;

        // Cargar grupos reales de Moodle para el Select
        try {
            const res = await axios.get(`/api/groups/${selectedCourseForGroups.courseId}`);
            if (res.data.ok) {
                setAvailableMoodleGroups(res.data.groups);
            }
        } catch (e) { console.error("Error cargando grupos moodle"); }

        if (groupSetting) {
            // MODO EDICIÓN
            const normalizedGroupId = String(groupSetting.groupId ?? '').trim();
            setEditingGroup(groupSetting);
            setTempGroupId(normalizedGroupId);
            // Intentamos buscar el nombre si no vino guardado
            setTempGroupName((groupSetting.groupName || '').trim());
            setTempMinutes(groupSetting.minMinutesPerDay);
            setTempThreshold(groupSetting.globalAttendancePercent);
            setTempSchedule(groupSetting.scheduleTime || '09:00 - 14:00');
            setTempStartDate(groupSetting.startDate ? new Date(groupSetting.startDate).toISOString().split('T')[0] : '');
            setTempEndDate(groupSetting.endDate ? new Date(groupSetting.endDate).toISOString().split('T')[0] : '');
            setTempHolidays(groupSetting.holidays || []);
            setTempTotalHours('30H'); // Dato visual, si quieres guardarlo agrégalo al esquema de grupo
        } else {
            // MODO CREAR NUEVO
            setEditingGroup(null);
            setTempGroupId('');
            setTempGroupName('');
            setTempMinutes(170);
            setTempThreshold(80);
            setTempSchedule('09:00 - 14:00');
            // Fechas por defecto (hoy y +3 meses)
            setTempStartDate(new Date().toISOString().split('T')[0]);
            const future = new Date(); future.setMonth(future.getMonth() + 3);
            setTempEndDate(future.toISOString().split('T')[0]);
            setTempHolidays([]);
            setTempTotalHours('30H');
        }

        setShowConfigModal(true);
    };

    const handleSaveGroupConfig = async () => {
        if (!selectedCourseForGroups || !tempGroupId) {
            alert("Debes seleccionar un grupo de Moodle");
            return;
        }

        setSavingConfig(true);
        try {
            // Buscamos el nombre del grupo seleccionado para guardarlo bonito
            const selectedMoodleGroup = availableMoodleGroups.find(g => String(g.id) === String(tempGroupId));
            const nameToSave = selectedMoodleGroup ? selectedMoodleGroup.name : tempGroupName;

            await axios.post('/api/attendance-settings', {
                courseId: String(selectedCourseForGroups.courseId),
                groupId: tempGroupId,
                groupName: nameToSave, // Guardamos nombre
                minMinutesPerDay: tempMinutes,
                globalAttendancePercent: tempThreshold,
                scheduleTime: tempSchedule,
                startDate: tempStartDate,
                endDate: tempEndDate,
                holidays: tempHolidays
            });

            // Recargar lista y cerrar
            await loadConfiguredGroups(selectedCourseForGroups.courseId);
            setShowConfigModal(false);
            setShowCalendarModal(false);
            alert("✅ Configuración de grupo guardada");

        } catch (error) {
            console.error(error);
            alert("Error al guardar grupo");
        } finally {
            setSavingConfig(false);
        }
    };

    const handleRegisterCourse = async () => {
        setLoadingAdd(true);
        try {
            const cleanUrl = newUrl.replace(/\/$/, "");
            const res = await axios.post('/api/courses/register', {
                moodleUrl: cleanUrl,
                moodleToken: newToken,
                courseId: newId,
                entityName: newEntity,
                cif: newCif
            });

            if (res.data.ok) {
                setShowAddModal(false);
                loadCourses();
                alert("✅ Curso registrado correctamente");
                setNewToken(''); setNewId('');
            } else {
                alert("⚠️ " + res.data.error);
            }
        } catch (e: any) {
            alert("❌ Error: " + (e.response?.data?.error || e.message));
        } finally {
            setLoadingAdd(false);
        }
    };

    // Sync silencioso: actualiza datos de Moodle en background sin bloquear la UI.
    // Se usa al abrir modales para que trabajen con datos frescos.
    const syncCourseInBackground = (course: RegisteredCourse) => {
        axios.get(`/api/dailystats/${course.courseId}`, {
            params: { courseShortname: course.shortname }
        }).then(() => {
            console.log(`🔄 Sync background OK: ${course.shortname}`);
        }).catch((err) => {
            console.warn(`⚠️ Sync background falló para ${course.shortname}:`, err?.message);
        });
    };

    const handleCardClick = async (course: RegisteredCourse) => {
        setSyncingId(course.courseId);
        try {
            await axios.get(`/api/dailystats/${course.courseId}`, {
                params: { courseShortname: course.shortname }
            });
            onCourseSelect(course);
        } catch (error: any) {
            console.error(error);
            const detalle = error?.response?.data?.detalle || error?.response?.data?.error || error?.message;
            alert(`Error al sincronizar datos${detalle ? `: ${detalle}` : ''}`);
        } finally {
            setSyncingId(null);
        }
    };

    const openCalendarModal = () => {
        setShowConfigModal(false);
        setShowCalendarModal(true);
    };

    const toggleHoliday = (dateStr: string) => {
        if (tempHolidays.includes(dateStr)) {
            setTempHolidays(prev => prev.filter(d => d !== dateStr));
        } else {
            setTempHolidays(prev => [...prev, dateStr]);
        }
    };


    return (
        <div className="container-fluid p-4">
            <div className="d-flex justify-content-between align-items-center mb-4">
                <div>
                    <h2 className="fw-bold text-dark m-0">Mis Cursos</h2>
                    {isAdmin && (
                        <small className="text-muted" style={{ fontSize: '0.75rem' }}>
                            <i className="fa-solid fa-grip-dots me-1"></i>Arrastra las tarjetas para reordenar
                        </small>
                    )}
                </div>
                <div className="d-flex align-items-center gap-2">
                    {isAdmin && (
                        <Button variant="outline-secondary" size="sm" onClick={() => setShowSyncOrderModal(true)} title="Sincronizar orden desde Moodle">
                            <i className="fa-solid fa-arrow-down-up-across-line me-1"></i>Orden desde Moodle
                        </Button>
                    )}
                    <Badge bg="secondary" className="fs-6">{courses.length} Cursos Activos</Badge>
                </div>
            </div>

            {courses.length === 0 ? (
                <div className="text-center py-5 text-muted">
                    <i className="fa-solid fa-folder-open fa-3x mb-3"></i>
                    <p>No tienes cursos registrados. ¡Agrega el primero!</p>
                </div>
            ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={isAdmin ? courses.map(c => c.courseId) : []} strategy={rectSortingStrategy}>
                <Row xs={1} md={2} lg={3} xl={4} className="g-4">
                    {courses.map(c => (
                        <Col key={c.courseId}>
                        <SortableCard id={c.courseId} disabled={!isAdmin}>
                        <Card className="h-100 shadow-sm border-0 card-hover" style={{ cursor: 'inherit' }}>
                                {/* PORTADA */}
                                <div style={{ height: '160px', position: 'relative', backgroundColor: '#f3f4f6' }}>
                                    <div id={`fallback-${c.courseId}`} style={{ height: '100%', background: '#2563eb', color: 'white', display: c.imageUrl ? 'none' : 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '2rem', fontWeight: 'bold' }}>
                                        {c.shortname.substring(0, 2).toUpperCase()}
                                    </div>
                                    {c.imageUrl && (
                                        <Card.Img
                                            variant="top"
                                            src={normalizeImageUrl(c.imageUrl)}
                                            style={{ height: '100%', objectFit: 'cover', position: 'absolute', top: 0, left: 0, width: '100%' }}
                                            onError={(e) => {
                                                (e.target as HTMLImageElement).style.display = 'none';
                                                const fb = document.getElementById(`fallback-${c.courseId}`);
                                                if (fb) fb.style.display = 'flex';
                                            }}
                                        />
                                    )}
                                    <Badge bg="dark" className="shadow-sm" style={{ position: 'absolute', top: '10px', right: '10px', opacity: 0.8 }}>ID: {c.courseId}</Badge>

                                    {syncingId === c.courseId && (
                                        <div style={{
                                            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                                            background: 'rgba(255,255,255,0.85)', zIndex: 10,
                                            display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center'
                                        }}>
                                            <Spinner animation="border" variant="primary" />
                                            <small className="text-primary fw-bold mt-2">Sincronizando...</small>
                                        </div>
                                    )}
                                </div>

                                <Card.Body className="d-flex flex-column pt-3" onClick={() => handleCardClick(c)} style={{ cursor: 'pointer' }}>
                                    <div className="d-flex justify-content-between align-items-center mb-2">
                                        <div className="text-truncate" style={{ maxWidth: '65%' }} title={c.shortname}>
                                            <Badge bg="primary" style={{ fontWeight: 500, fontSize: '0.9rem' }}>
                                                {c.shortname}
                                            </Badge>
                                        </div>

                                        <div className="d-flex gap-3 bg-light rounded px-2 py-1">
                                            <i className="fa-solid fa-user-plus text-primary icon-hover icon-blue-hover"
                                                style={{ cursor: 'pointer', fontSize: '1rem' }}
                                                onClick={(e) => { e.stopPropagation(); syncCourseInBackground(c); setEnrolTargetCourse(c); setShowEnrolModal(true); }}
                                                title="Inscripción Masiva"
                                            ></i>
                                            <i className="fa-solid fa-diagram-project text-success icon-hover"
                                                style={{ cursor: 'pointer', fontSize: '1rem' }}
                                                onClick={(e) => { e.stopPropagation(); syncCourseInBackground(c); setConditionalTargetCourse(c); setShowConditionalModal(true); }}
                                                title="Inscripción Condicional"
                                            ></i>
                                            <i className="fa-solid fa-gear text-secondary icon-hover"
                                                style={{ cursor: 'pointer', fontSize: '1rem' }}
                                                onClick={(e) => { syncCourseInBackground(c); handleOpenGroupsManager(c, e); }}
                                                title="Configurar Grupos"
                                            ></i>
                                            <i className="fa-regular fa-trash-can text-danger icon-hover icon-delete-hover"
                                                style={{ cursor: 'pointer', fontSize: '1rem' }}
                                                onClick={(e) => confirmDelete(c, e)}
                                                title="Eliminar"
                                            ></i>
                                        </div>
                                    </div>

                                    <Card.Title className="fw-bold text-dark mb-3"
                                        style={{ fontSize: '1.1rem', lineHeight: '1.4', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', height: '3.1em' }}
                                        title={c.fullname} >
                                        {c.fullname}
                                    </Card.Title>

                                    <div className="mt-auto">
                                        <div className="d-flex justify-content-between small text-muted border-top pt-2">
                                            <span><i className="fa-regular fa-building me-1 text-primary"></i>{c.entityName || 'Entidad'}</span>
                                        </div>
                                    </div>
                                </Card.Body>
                            </Card>
                        </SortableCard>
                        </Col>

                    ))}
                </Row>
                </SortableContext>
                </DndContext>
            )}

            {/* MODAL SINCRONIZAR ORDEN DESDE MOODLE */}
            <Modal show={showSyncOrderModal} onHide={() => setShowSyncOrderModal(false)} centered>
                <Modal.Header closeButton>
                    <Modal.Title><i className="fa-solid fa-arrow-down-up-across-line me-2"></i>Sincronizar orden desde Moodle</Modal.Title>
                </Modal.Header>
                <Modal.Body>
                    <Alert variant="info" className="small">
                        El servidor leerá las secciones del curso padre e intentará encontrar enlaces a los cursos registrados. El orden de las tarjetas seguirá el orden de las secciones en Moodle.
                    </Alert>
                    <Form.Group>
                        <Form.Label className="fw-bold">ID del curso padre (itinerario)</Form.Label>
                        <Form.Control
                            type="number"
                            value={parentCourseIdInput}
                            onChange={e => setParentCourseIdInput(e.target.value)}
                            placeholder="ej: 681"
                        />
                        <Form.Text className="text-muted">El ID del curso en Moodle que contiene los enlaces al resto de cursos.</Form.Text>
                    </Form.Group>
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="secondary" onClick={() => setShowSyncOrderModal(false)}>Cancelar</Button>
                    <Button variant="primary" onClick={handleSyncOrderFromMoodle} disabled={syncingOrder}>
                        {syncingOrder ? <><Spinner size="sm" className="me-1" />Sincronizando...</> : <><i className="fa-solid fa-rotate me-1"></i>Sincronizar</>}
                    </Button>
                </Modal.Footer>
            </Modal>

            {/* BOTÓN FLOTANTE (+) — solo admin */}
            {isAdmin && (
                <button
                    className="btn btn-primary rounded-circle shadow-lg d-flex align-items-center justify-content-center"
                    style={{ position: 'fixed', bottom: '30px', right: '30px', width: '60px', height: '60px', fontSize: '24px', zIndex: 100, border: '4px solid white' }}
                    onClick={() => setShowAddModal(true)}
                >
                    <i className="fa-solid fa-plus"></i>
                </button>
            )}

            {/* MODAL AGREGAR CURSO */}
            <Modal show={showAddModal} onHide={() => setShowAddModal(false)} centered backdrop="static">
                <Modal.Header closeButton>
                    <Modal.Title>Agregar Nuevo Curso</Modal.Title>
                </Modal.Header>
                <Modal.Body>
                    <Form>
                        <div className="bg-light p-2 rounded mb-3 border">
                            <h6 className="small text-muted fw-bold mb-2">Datos para Reportes</h6>
                            <Row>
                                <Col md={8}>
                                    <Form.Group className="mb-2">
                                        <Form.Label className="small">Entidad de Formación</Form.Label>
                                        <Form.Control size="sm" value={newEntity} onChange={e => setNewEntity(e.target.value)} />
                                    </Form.Group>
                                </Col>
                                <Col md={4}>
                                    <Form.Group className="mb-2">
                                        <Form.Label className="small">CIF</Form.Label>
                                        <Form.Control size="sm" value={newCif} onChange={e => setNewCif(e.target.value)} />
                                    </Form.Group>
                                </Col>
                            </Row>
                        </div>
                        <Form.Group className="mb-3">
                            <Form.Label>URL Moodle</Form.Label>
                            <Form.Control value={newUrl} onChange={e => setNewUrl(e.target.value)} />
                        </Form.Group>
                        <Form.Group className="mb-3">
                            <Form.Label>ID del Curso</Form.Label>
                            <Form.Control value={newId} onChange={e => setNewId(e.target.value)} placeholder="Ej: 942" autoFocus />
                        </Form.Group>
                        <Form.Group className="mb-3">
                            <Form.Label>Token WebService</Form.Label>
                            <Form.Control value={newToken} type="password" onChange={e => setNewToken(e.target.value)} />
                        </Form.Group>
                    </Form>
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="secondary" onClick={() => setShowAddModal(false)}>Cancelar</Button>
                    <Button variant="primary" onClick={handleRegisterCourse} disabled={loadingAdd}>
                        {loadingAdd ? <><Spinner as="span" animation="border" size="sm" /> Verificando...</> : 'Agregar Curso'}
                    </Button>
                </Modal.Footer>
            </Modal>

            <Modal show={showGroupsListModal} onHide={() => setShowGroupsListModal(false)} size="lg" centered>
                <Modal.Header closeButton className="bg-light">
                    <Modal.Title>
                        <i className="fa-solid fa-users-gear me-2"></i>
                        Grupos de: {selectedCourseForGroups?.shortname}
                    </Modal.Title>
                </Modal.Header>
                <Modal.Body className="p-4">
                    <div className="d-flex justify-content-between align-items-center mb-3">
                        <h5 className="m-0 fw-bold">Grupos Configurados</h5>
                        <Button variant="success" size="sm" onClick={() => handleOpenConfigModal(null)}>
                            <i className="fa-solid fa-plus me-2"></i>Agregar Grupo
                        </Button>
                    </div>

                    {configuredGroups.length === 0 ? (
                        <Alert variant="info" className="text-center">
                            <i className="fa-solid fa-info-circle me-2"></i>
                            No hay grupos configurados aún. ¡Agrega uno para empezar!
                        </Alert>
                    ) : (
                        <Table hover responsive className="align-middle">
                            <thead className="bg-light">
                                <tr>
                                    <th>Grupo Moodle</th>
                                    <th>Inicio</th>
                                    <th>Fin</th>
                                    <th className="text-center">Config</th>
                                </tr>
                            </thead>
                            <tbody>
                                {configuredGroups.map((grp, idx) => (
                                    <tr key={idx}>
                                        <td className="fw-bold">{grp.groupName || `ID: ${grp.groupId}`}</td>
                                        <td>{grp.startDate ? new Date(grp.startDate).toLocaleDateString() : '-'}</td>
                                        <td>{grp.endDate ? new Date(grp.endDate).toLocaleDateString() : '-'}</td>
                                        <td className="text-center">
                                            <Button variant="outline-primary" size="sm" className="me-2" onClick={() => handleOpenConfigModal(grp)}>
                                                <i className="fa-solid fa-gear"></i>
                                            </Button>
                                            <Button variant="outline-danger" size="sm" onClick={() => handleDeleteGroup(grp)}>
                                                <i className="fa-solid fa-trash"></i>
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </Table>
                    )}
                </Modal.Body>
            </Modal>

            <Modal show={showConfigModal} onHide={() => setShowConfigModal(false)} centered backdrop="static" size="lg">
                <Modal.Header closeButton>
                    <Modal.Title className="fs-5">
                        {editingGroup ? 'Editar Grupo' : 'Nuevo Grupo'}
                    </Modal.Title>
                </Modal.Header>
                <Modal.Body>
                    <Form>
                        {/* SELECTOR DE GRUPO MOODLE */}
                        <div className="bg-light p-3 rounded mb-3">
                            <Form.Group>
                                <Form.Label className="fw-bold">Seleccionar Grupo de Moodle</Form.Label>
                                <Form.Select
                                    value={normalizedTempGroupId}
                                    onChange={(e) => setTempGroupId(e.target.value)}
                                    disabled={!!editingGroup}
                                    className="form-select"
                                >
                                    <option value="">-- Selecciona un grupo --</option>
                                    {editingGroup && normalizedTempGroupId && !selectedGroupExistsInOptions && (
                                        <option value={normalizedTempGroupId}>
                                            {tempGroupName || `ID: ${normalizedTempGroupId}`}
                                        </option>
                                    )}
                                    {availableMoodleGroups.map(g => (
                                        <option key={g.id} value={String(g.id)}>{g.name} (ID: {g.id})</option>
                                    ))}
                                </Form.Select>
                                {!editingGroup && <Form.Text className="text-muted">Elige el grupo real de Moodle al que aplicarás estas reglas.</Form.Text>}
                            </Form.Group>
                        </div>

                        {/* FECHAS */}
                        <Row>
                            <Col md={6}>
                                <Form.Group className="mb-3">
                                    <Form.Label className="small fw-bold">Fecha Inicio</Form.Label>
                                    <Form.Control type="date" value={tempStartDate} onChange={e => setTempStartDate(e.target.value)} />
                                </Form.Group>
                            </Col>
                            <Col md={6}>
                                <Form.Group className="mb-3">
                                    <Form.Label className="small fw-bold">Fecha Fin</Form.Label>
                                    <Form.Control type="date" value={tempEndDate} onChange={e => setTempEndDate(e.target.value)} />
                                </Form.Group>
                            </Col>
                        </Row>

                        <hr className="my-2" />

                        <Row>
                            <Col md={6}>
                                <Form.Group className="mb-3">
                                    <Form.Label className="small fw-bold">⏱️ Objetivo (Min)</Form.Label>
                                    <Form.Control type="number" value={tempMinutes} onChange={e => setTempMinutes(e.target.value)} />
                                </Form.Group>
                            </Col>
                            <Col md={6}>
                                <Form.Group className="mb-3">
                                    <Form.Label className="small fw-bold">📊 Umbral (%)</Form.Label>
                                    <Form.Control type="number" max={100} value={tempThreshold} onChange={e => setTempThreshold(e.target.value)} />
                                </Form.Group>
                            </Col>
                        </Row>
                        <Row>
                            <Col md={6}>
                                <Form.Group className="mb-3">
                                    <Form.Label className="small fw-bold">⏳ Total Horas (Texto)</Form.Label>
                                    <Form.Control type="text" value={tempTotalHours} onChange={e => setTempTotalHours(e.target.value)} />
                                </Form.Group>
                            </Col>
                            <Col md={6}>
                                <Form.Group className="mb-3">
                                    <Form.Label className="small fw-bold">📅 Horario</Form.Label>
                                    <Form.Control type="text" value={tempSchedule} onChange={e => setTempSchedule(e.target.value)}
                                        onBlur={(e) => autoCalculateMinutes(e.target.value)}
                                        placeholder="Ej: 09:00 - 14:00" />
                                </Form.Group>
                            </Col>
                        </Row>
                        <div className="d-grid mt-2">
                            <Button variant="outline-primary" onClick={openCalendarModal}>
                                <i className="fa-regular fa-calendar-days me-2"></i>Configurar Feriados del Grupo
                            </Button>
                        </div>
                    </Form>
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="light" size="sm" onClick={() => setShowConfigModal(false)}>Cancelar</Button>
                    <Button variant="primary" size="sm" onClick={handleSaveGroupConfig} disabled={savingConfig}>
                        {savingConfig ? 'Guardando...' : 'Guardar Grupo'}
                    </Button>
                </Modal.Footer>
            </Modal>

            {/* MODAL CALENDARIO */}
            <Modal show={showCalendarModal} onHide={() => { setShowCalendarModal(false); setShowConfigModal(true); }} size="lg" scrollable>
                <Modal.Header closeButton>
                    <Modal.Title className="fs-5">Calendario del Grupo</Modal.Title>
                </Modal.Header>
                <Modal.Body style={{ backgroundColor: '#f8f9fa' }}>
                    {renderCalendarMonths()}
                </Modal.Body>
                <Modal.Footer>
                    <Button variant="secondary" onClick={() => { setShowCalendarModal(false); setShowConfigModal(true); }}>Volver</Button>
                    <Button variant="success" onClick={handleSaveGroupConfig}>Guardar Todo</Button>
                </Modal.Footer>
            </Modal>

            {/* MODAL ELIMINAR CURSO */}
            <Modal show={showDeleteModal} onHide={() => setShowDeleteModal(false)} centered size="sm">
                <Modal.Header closeButton className="border-0 pb-0">
                    <Modal.Title className="fs-5 text-danger"><i className="fa-solid fa-triangle-exclamation me-2"></i>Eliminar</Modal.Title>
                </Modal.Header>
                <Modal.Body className="text-center pt-2">
                    <p>¿Eliminar <strong>{courseToDelete?.shortname}</strong>?</p>
                    <small className="text-muted">Se borrarán todos sus datos.</small>
                </Modal.Body>
                <Modal.Footer className="border-0 justify-content-center">
                    <Button variant="light" onClick={() => setShowDeleteModal(false)}>Cancelar</Button>
                    <Button variant="danger" onClick={handleDeleteCourse} disabled={isDeleting}>{isDeleting ? '...' : 'Eliminar'}</Button>
                </Modal.Footer>
            </Modal>

            {/* MODAL INSCRIPCIÓN MASIVA */}
            <BulkEnrolModal
                show={showEnrolModal}
                onHide={() => { setShowEnrolModal(false); setEnrolTargetCourse(null); }}
                destCourse={enrolTargetCourse}
            />

            <ConditionalEnrolModal
                show={showConditionalModal}
                onHide={() => { setShowConditionalModal(false); setConditionalTargetCourse(null); }}
                destCourse={conditionalTargetCourse}
            />
        </div>
    );
}

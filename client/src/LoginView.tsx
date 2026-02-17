import { useState } from 'react';
import axios from 'axios';
import { Card, Form, Button, Spinner, Alert, Container } from 'react-bootstrap';

interface LoginViewProps {
    onLoginSuccess: (userData: any) => void;
}

export function LoginView({ onLoginSuccess }: LoginViewProps) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const res = await axios.post('http://localhost:3000/api/auth/login', {
                username,
                password
            });

            if (res.data.ok) {
                localStorage.setItem('app_user', JSON.stringify(res.data.user));
                onLoginSuccess(res.data.user);
            } else {
                setError(res.data.error || 'Error de autenticación');
            }
        } catch (err: any) {
            setError(err.response?.data?.error || 'Error al conectar con el servidor');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{ 
            height: '100vh', 
            background: 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center' 
        }}>
            <Container style={{ maxWidth: '400px' }}>
                <Card className="shadow-lg border-0">
                    <Card.Body className="p-5">
                        <div className="text-center mb-4">
                            <div className="bg-primary text-white rounded-circle d-inline-flex align-items-center justify-content-center mb-3" style={{ width: '60px', height: '60px', fontSize: '24px' }}>
                                <i className="fa-solid fa-user-lock"></i>
                            </div>
                            <h4 className="fw-bold text-dark">Iniciar Sesión</h4>
                            <p className="text-muted small">Control de Asistencia</p>
                        </div>

                        {error && <Alert variant="danger" className="py-2 small text-center">{error}</Alert>}

                        <Form onSubmit={handleSubmit}>
                            <Form.Group className="mb-3">
                                <Form.Label className="small fw-bold text-secondary">Usuario</Form.Label>
                                <Form.Control 
                                    type="text" 
                                    placeholder="admin"
                                    value={username} 
                                    onChange={e => setUsername(e.target.value)} 
                                    autoFocus
                                />
                            </Form.Group>

                            <Form.Group className="mb-4">
                                <Form.Label className="small fw-bold text-secondary">Contraseña</Form.Label>
                                <Form.Control 
                                    type="password" 
                                    placeholder="••••••"
                                    value={password} 
                                    onChange={e => setPassword(e.target.value)} 
                                />
                            </Form.Group>

                            <Button variant="primary" type="submit" className="w-100 py-2 fw-bold shadow-sm" disabled={loading}>
                                {loading ? <Spinner as="span" animation="border" size="sm" /> : 'Entrar al Sistema'}
                            </Button>
                        </Form>
                    </Card.Body>
                    <Card.Footer className="text-center bg-light border-0 py-3">
                        <small className="text-muted">© 2026 Formación Técnica S.A.</small>
                    </Card.Footer>
                </Card>
            </Container>
        </div>
    );
}
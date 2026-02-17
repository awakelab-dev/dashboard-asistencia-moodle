import { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
// import { Navbar } from 'react-bootstrap'; 
import { ReportesView } from './components/ReportesView';
import { DashboardView } from './components/DashboardView';
import { LoginView } from './LoginView';
import './styles-dashboard.css';

function App() {
  const [user, setUser] = useState<any>(null);

  // Estados de navegación
  const [selectedCourse, setSelectedCourse] = useState(null);
  const [currentView, setCurrentView] = useState<'dashboard' | 'reportes'>('dashboard');

  useEffect(() => {
    const savedUser = localStorage.getItem('app_user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('app_user');
    setUser(null);
    setCurrentView('dashboard');
    setSelectedCourse(null);
  };

  if (!user) {
    return <LoginView onLoginSuccess={(u: any) => setUser(u)} />;
  }

  return (
    <div>
      <nav className="navbar navbar-dark bg-dark px-4 shadow-sm mb-3">
        <span className="navbar-brand mb-0 h1 fw-bold">
          <i className="fa-solid fa-layer-group me-2"></i>Control Asistencia
        </span>
        <div className="d-flex align-items-center gap-3">
          <span className="text-white small">Hola, {user?.name}</span>
          <button onClick={handleLogout} className="btn btn-outline-light btn-sm">
            <i className="fa-solid fa-right-from-bracket me-2"></i>Salir
          </button>
        </div>
      </nav>

      {/* RUTAS VIRTUALES */}
      {currentView === 'dashboard' && (
        <DashboardView
          onCourseSelect={(course) => {
            setSelectedCourse(course);
            setCurrentView('reportes');
          }}
        />
      )}

      {currentView === 'reportes' && selectedCourse && (
        <ReportesView
          courseData={selectedCourse}
          onBack={() => {
            setSelectedCourse(null);
            setCurrentView('dashboard');
          }}
        />
      )}

    </div>
  )
}

export default App;
import { useState } from 'react';
import axios from 'axios';

export function WeeklyReportExporter() {
  const [courseId, setCourseId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  
  const handleDownload = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      // Ajusta la URL si es necesario
      const response = await axios.get('http://localhost:3000/api/reports/weekly-export', {
        params: { courseId, startDate, endDate },
        responseType: 'blob',
      });

      // Crear enlace de descarga
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      
      // Intentar obtener nombre del archivo
      const contentDisposition = response.headers['content-disposition'];
      let fileName = `Reporte_Semanal_${courseId}.xlsx`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?(.+)"?/);
        if (match && match[1]) fileName = match[1];
      }

      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

    } catch (err: any) {
      console.error(err);
      setError('Error al descargar. Revisa los datos.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <article className="card" aria-labelledby="weekly-title">
      <header className="card__header">
        <i className="fa-solid fa-calendar-week card__icon" aria-hidden="true"></i>
        <h2 id="weekly-title" className="card__title">Exportar Reporte Semanal</h2>
      </header>
      <div className="card__body">
        <form className="form-grid" onSubmit={handleDownload}>
          <div className="form-field">
            <label htmlFor="weekly-course" className="form-label">Course ID (Shortname)</label>
            <input 
              id="weekly-course" type="text" className="input" placeholder="p.ej. CD"
              value={courseId} onChange={(e) => setCourseId(e.target.value)} required
            />
          </div>
          <div className="form-field">
            <label htmlFor="weekly-start" className="form-label">Fecha Inicio</label>
            <input 
              id="weekly-start" type="date" className="input"
              value={startDate} onChange={(e) => setStartDate(e.target.value)} required
            />
          </div>
          <div className="form-field">
            <label htmlFor="weekly-end" className="form-label">Fecha Fin</label>
            <input 
              id="weekly-end" type="date" className="input"
              value={endDate} onChange={(e) => setEndDate(e.target.value)} required
            />
          </div>
          
          {error && <p className="error-msg">{error}</p>}

          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={loading}>
              {loading ? (
                <span>Generando...</span>
              ) : (
                <>
                  <i className="fa-solid fa-file-arrow-down" aria-hidden="true"></i>
                  Descargar Excel Semanal
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </article>
  );
}
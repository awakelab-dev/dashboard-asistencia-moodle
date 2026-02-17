import { useState } from 'react';

interface Props {
  apiBaseUrl?: string;
}

export function DailyReportExporter({ apiBaseUrl = '' }: Props) {
  const [courseId, setCourseId] = useState('');
  const [reportDate, setReportDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!courseId || !reportDate) return;
    setLoading(true);

    try {
      const url = `${apiBaseUrl}/api/reports/daily-export?courseId=${courseId}&date=${reportDate}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Error generando CSV');

      const blob = await resp.blob();
      const objUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = `Reporte_Diario-${courseId}-${reportDate}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError('Error al descargar el CSV.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <article className="card" aria-labelledby="daily-title">
      <header className="card__header">
        <i className="fa-solid fa-calendar-day card__icon" aria-hidden="true"></i>
        <h2 id="daily-title" className="card__title">Exportar CSV Diario</h2>
      </header>
      <div className="card__body">
        <form className="form-grid" onSubmit={onSubmit}>
          <div className="form-field">
            <label htmlFor="daily-course" className="form-label">Course ID (Shortname)</label>
            <input 
              id="daily-course" type="text" className="input" placeholder="p.ej. CD"
              value={courseId} onChange={(e) => setCourseId(e.target.value)} required
            />
          </div>
          <div className="form-field">
            <label htmlFor="daily-date" className="form-label">Fecha</label>
            <input 
              id="daily-date" type="date" className="input"
              value={reportDate} onChange={(e) => setReportDate(e.target.value)} required
            />
          </div>

          {error && <p className="error-msg">{error}</p>}

          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={loading}>
              {loading ? (
                <span>Generando...</span>
              ) : (
                <>
                  <i className="fa-solid fa-file-csv" aria-hidden="true"></i>
                  Descargar CSV Diario
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </article>
  );
}
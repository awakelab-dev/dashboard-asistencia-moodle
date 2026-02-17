import React, { useState, useEffect, useMemo } from 'react';

interface Course {
  id: number;
  fullname: string;
  shortname: string;
}

interface CourseSelectorProps {
  courses: Course[];
  selectedValue: string;
  onChange: (val: string) => void;
  label?: string;
  disabled?: boolean;
}

export const CourseSelector: React.FC<CourseSelectorProps> = ({
  courses,
  selectedValue,
  onChange,
  label = "Curso",
  disabled = false
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isFocused, setIsFocused] = useState(false);

  const selectedCourseObj = courses.find(c => c.shortname === selectedValue);

  useEffect(() => {
    if (selectedValue) {
      setSearchTerm('');
    }
  }, [selectedValue]);

  const filteredCourses = useMemo(() => {
    if (!searchTerm) return courses;

    const lowerTerm = searchTerm.trim().toLowerCase();

    return courses.filter(c => {
      const fullName = (c.fullname || '').toString().toLowerCase().trim();
      const shortName = (c.shortname || '').toString().toLowerCase().trim();
     
      return fullName.includes(lowerTerm) || shortName.includes(lowerTerm);
    });
  }, [courses, searchTerm]);

  const handleSelect = (val: string) => {
    onChange(val);
    setSearchTerm(''); 
    setIsFocused(false);
  };

  const clearSelection = () => {
    onChange('');
    setSearchTerm('');
    setIsFocused(true);
  };

  return (
    <div className="form-field" style={{ position: 'relative' }}>
      <label className="form-label">{label}</label>

      <div style={{ position: 'relative' }}>
        {/* ICONO */}
        <span style={{ position: 'absolute', left: '10px', top: '10px', opacity: 0.5, zIndex: 5 }}>
          {selectedCourseObj ? '✅' : '🔍'}
        </span>

        {/* INPUT VISUAL */}
        <input
          type="text"
          className="input"
          placeholder={selectedCourseObj ? `${selectedCourseObj.shortname} - ${selectedCourseObj.fullname}` : "Escribe para buscar curso..."}

          value={selectedCourseObj && !isFocused && !searchTerm ? `${selectedCourseObj.shortname} - ${selectedCourseObj.fullname}` : searchTerm}

          onChange={(e) => {
            setSearchTerm(e.target.value);
            if (selectedCourseObj && e.target.value === '') {
              onChange('');
            }
          }}
          onFocus={() => {
            setIsFocused(true);
            if (selectedCourseObj) setSearchTerm(''); 
          }}
          onBlur={() => {
            setTimeout(() => setIsFocused(false), 200);
          }}
          disabled={disabled}
          style={{
            paddingLeft: '35px',
            paddingRight: '30px',
            backgroundColor: selectedCourseObj ? '#f0fdf4' : '#fff',
            borderColor: selectedCourseObj ? '#10b981' : '#e5e7eb', 
            fontWeight: selectedCourseObj ? 500 : 400
          }}
        />

        {/* BOTÓN LIMPIAR (X) */}
        {(selectedCourseObj || searchTerm) && (
          <button
            type="button"
            onClick={clearSelection}
            style={{
              position: 'absolute', right: '10px', top: '8px',
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '1.1rem', color: '#6b7280'
            }}
            title="Limpiar selección"
          >
            &times;
          </button>
        )}
      </div>

      {/* LISTA FLOTANTE (Sugerencias) */}
      {isFocused && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          maxHeight: '250px',
          overflowY: 'auto',
          background: 'white',
          border: '1px solid #e5e7eb',
          borderRadius: '0 0 8px 8px',
          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
          zIndex: 1000,
          marginTop: '2px'
        }}>
          {filteredCourses.length > 0 ? (
            filteredCourses.map(course => (
              <div
                key={course.id}
                onClick={() => handleSelect(course.shortname)}
                style={{
                  padding: '10px 15px',
                  cursor: 'pointer',
                  borderBottom: '1px solid #f3f4f6',
                  transition: 'background 0.1s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f9fafb'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'white'}
              >
                <div style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>{course.shortname}</div>
                <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>{course.fullname}</div>
              </div>
            ))
          ) : (
            <div style={{ padding: '15px', textAlign: 'center', color: '#9ca3af' }}>
              No se encontraron cursos
            </div>
          )}
        </div>
      )}

    </div>
  );
};
import { useState, useEffect } from 'react';

export default function GitHubStars() {
  const [stars, setStars] = useState<number | null>(null);
  const [forks, setForks] = useState<number | null>(null);

  useEffect(() => {
    fetch('https://api.github.com/repos/matiasdaloia/concilium')
      .then((res) => {
        if (!res.ok) return;
        return res.json();
      })
      .then((data) => {
        if (data) {
          setStars(data.stargazers_count ?? 0);
          setForks(data.forks_count ?? 0);
        }
      })
      .catch(() => {
        // Silently fail — static counts remain hidden
      });
  }, []);

  if (stars === null) return null;

  return (
    <div className="flex items-center gap-4 text-xs text-text-muted font-mono" id="github-stars-live">
      <span className="flex items-center gap-1.5">
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
        {stars} stars
      </span>
      {forks !== null && (
        <span className="flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 7V3m10 4V3M7 7a4 4 0 004 4h2a4 4 0 004-4M7 7H3m14 0h4M12 21v-6" />
          </svg>
          {forks} forks
        </span>
      )}
    </div>
  );
}

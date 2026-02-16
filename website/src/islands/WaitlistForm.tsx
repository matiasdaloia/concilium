import { useState, type FormEvent } from 'react';

type FormState = 'idle' | 'loading' | 'success' | 'error' | 'duplicate' | 'invalid';

export default function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<FormState>('idle');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState('loading');

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();

      if (data.success) {
        setState('success');
      } else if (data.error === 'already_registered') {
        setState('duplicate');
      } else if (data.error === 'invalid_email') {
        setState('invalid');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  }

  if (state === 'success') {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)' }}
        >
          <svg className="w-6 h-6" style={{ color: '#22C55E' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-sm font-bold font-mono" style={{ color: '#F5F5F5' }}>
          You're on the list
        </p>
        <p className="text-[11px] font-mono" style={{ color: '#404040' }}>
          We'll notify you when Concilium Cloud is ready.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col items-center gap-4">
      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-md">
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (state !== 'idle' && state !== 'loading') setState('idle');
          }}
          placeholder="you@example.com"
          required
          disabled={state === 'loading'}
          className="flex-1 px-4 py-3 rounded-md text-sm font-mono transition-colors disabled:opacity-50"
          style={{
            background: '#0A0A0A',
            border: '1px solid #262626',
            color: '#F5F5F5',
            outline: 'none',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'rgba(34,197,94,0.5)';
            e.currentTarget.style.boxShadow = '0 0 0 1px rgba(34,197,94,0.2)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = '#262626';
            e.currentTarget.style.boxShadow = 'none';
          }}
        />
        <button
          type="submit"
          disabled={state === 'loading' || !email.trim()}
          className="px-6 py-3 font-bold font-mono text-xs tracking-widest uppercase rounded-md transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-w-[140px]"
          style={{
            background: '#22C55E',
            color: '#000',
            boxShadow: '0 0 20px rgba(34,197,94,0.3)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#15803D';
            e.currentTarget.style.boxShadow = '0 0 30px rgba(34,197,94,0.5)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#22C55E';
            e.currentTarget.style.boxShadow = '0 0 20px rgba(34,197,94,0.3)';
          }}
        >
          {state === 'loading' ? (
            <>
              <span
                className="w-3 h-3 rounded-full animate-spin"
                style={{ border: '2px solid rgba(0,0,0,0.3)', borderTopColor: '#000' }}
              />
              Joining...
            </>
          ) : (
            'Join Waitlist'
          )}
        </button>
      </div>

      {state === 'error' && (
        <p className="text-[11px] font-mono" style={{ color: '#EF4444' }}>
          Something went wrong. Please try again.
        </p>
      )}
      {state === 'duplicate' && (
        <p className="text-[11px] font-mono" style={{ color: '#F59E0B' }}>
          This email is already on the waitlist.
        </p>
      )}
      {state === 'invalid' && (
        <p className="text-[11px] font-mono" style={{ color: '#EF4444' }}>
          Please enter a valid email address.
        </p>
      )}
    </form>
  );
}

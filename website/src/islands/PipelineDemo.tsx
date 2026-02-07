import { useState, useEffect, useRef, useCallback } from 'react';

type DemoStage = 1 | 2 | 3 | 'done';

interface AgentState {
  name: string;
  color: string;
  text: string;
  status: 'queued' | 'running' | 'success';
}

interface JurorState {
  name: string;
  progress: number;
  status: 'pending' | 'evaluating' | 'complete';
}

const AGENT_RESPONSES = {
  opencode: `## Approach\nI'll implement the authentication system using JWT tokens with refresh token rotation.\n\n### Steps:\n1. Create auth middleware\n2. Set up token generation\n3. Implement login/register endpoints\n4. Add token refresh logic\n\n\`\`\`typescript\nconst authMiddleware = (req, res, next) => {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) return res.status(401).json({ error: 'Unauthorized' });\n  // verify token...\n};\n\`\`\``,
  codex: `## Implementation Plan\nI recommend using session-based auth with Redis for scalability.\n\n### Architecture:\n- Express session middleware\n- Redis session store\n- CSRF protection\n- Rate limiting on auth endpoints\n\n\`\`\`typescript\napp.use(session({\n  store: new RedisStore({ client: redisClient }),\n  secret: process.env.SESSION_SECRET,\n  resave: false,\n  saveUninitialized: false\n}));\n\`\`\``,
  claude: `## Solution\nFor this use case, I'd suggest OAuth 2.0 with PKCE flow.\n\n### Key Components:\n1. Authorization server setup\n2. PKCE challenge/verifier generation\n3. Token exchange endpoint\n4. Secure cookie storage\n\n\`\`\`typescript\nfunction generatePKCE() {\n  const verifier = crypto.randomBytes(32)\n    .toString('base64url');\n  const challenge = crypto.createHash('sha256')\n    .update(verifier).digest('base64url');\n  return { verifier, challenge };\n}\n\`\`\``,
};

const JUROR_NAMES = ['juror_1', 'juror_2', 'juror_3', 'juror_4'];

const SYNTHESIS = `## Chairman's Synthesis\n\nAfter reviewing all approaches, the council recommends a **hybrid approach**:\n\n1. **JWT for API authentication** (from Response A) — stateless, scalable\n2. **Redis for session management** (from Response B) — fast token revocation\n3. **PKCE flow for OAuth** (from Response C) — secure authorization\n\nThis combines the scalability of JWT, the revocation capability of Redis-backed sessions, and the security of PKCE for third-party auth flows.`;

export default function PipelineDemo() {
  const [stage, setStage] = useState<DemoStage>(1);
  const [playing, setPlaying] = useState(false);
  const [agents, setAgents] = useState<Record<string, AgentState>>({
    opencode: { name: 'OpenCode', color: '#22C55E', text: '', status: 'queued' },
    codex: { name: 'Codex', color: '#3B82F6', text: '', status: 'queued' },
    claude: { name: 'Claude', color: '#A855F7', text: '', status: 'queued' },
  });
  const [jurors, setJurors] = useState<JurorState[]>(
    JUROR_NAMES.map((name) => ({ name, progress: 0, status: 'pending' }))
  );
  const [synthesis, setSynthesis] = useState('');
  const [leaderboard, setLeaderboard] = useState<{ name: string; rank: number }[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reset = useCallback(() => {
    setStage(1);
    setPlaying(false);
    setAgents({
      opencode: { name: 'OpenCode', color: '#22C55E', text: '', status: 'queued' },
      codex: { name: 'Codex', color: '#3B82F6', text: '', status: 'queued' },
      claude: { name: 'Claude', color: '#A855F7', text: '', status: 'queued' },
    });
    setJurors(JUROR_NAMES.map((name) => ({ name, progress: 0, status: 'pending' })));
    setSynthesis('');
    setLeaderboard([]);
  }, []);

  useEffect(() => {
    if (!playing) return;

    let cancelled = false;
    const entries = Object.entries(AGENT_RESPONSES) as [string, string][];

    async function runDemo() {
      // Stage 1: Type out agent responses
      setAgents((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          next[key] = { ...next[key], status: 'running' };
        }
        return next;
      });

      for (let charIdx = 0; charIdx < 400; charIdx++) {
        if (cancelled) return;
        await new Promise((r) => { timerRef.current = setTimeout(r, 20); });
        setAgents((prev) => {
          const next = { ...prev };
          for (const [key, fullText] of entries) {
            if (charIdx < fullText.length) {
              next[key] = { ...next[key], text: fullText.slice(0, charIdx + 1) };
            }
          }
          return next;
        });
      }

      // Mark agents as done
      setAgents((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          next[key] = { ...next[key], status: 'success' };
        }
        return next;
      });

      if (cancelled) return;
      await new Promise((r) => { timerRef.current = setTimeout(r, 500); });

      // Stage 2: Jurors evaluate
      setStage(2);
      for (let i = 0; i < JUROR_NAMES.length; i++) {
        if (cancelled) return;
        setJurors((prev) => prev.map((j, idx) => idx === i ? { ...j, status: 'evaluating' } : j));

        for (let p = 0; p <= 100; p += 5) {
          if (cancelled) return;
          await new Promise((r) => { timerRef.current = setTimeout(r, 50 + Math.random() * 30); });
          setJurors((prev) => prev.map((j, idx) => idx === i ? { ...j, progress: p } : j));
        }

        setJurors((prev) => prev.map((j, idx) => idx === i ? { ...j, status: 'complete', progress: 100 } : j));
      }

      // Show leaderboard
      setLeaderboard([
        { name: 'Claude', rank: 1 },
        { name: 'OpenCode', rank: 2 },
        { name: 'Codex', rank: 3 },
      ]);

      if (cancelled) return;
      await new Promise((r) => { timerRef.current = setTimeout(r, 800); });

      // Stage 3: Synthesis
      setStage(3);
      for (let charIdx = 0; charIdx < SYNTHESIS.length; charIdx++) {
        if (cancelled) return;
        await new Promise((r) => { timerRef.current = setTimeout(r, 10); });
        setSynthesis(SYNTHESIS.slice(0, charIdx + 1));
      }

      setStage('done');
      setPlaying(false);
    }

    runDemo();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [playing]);

  const stageNum = stage === 'done' ? 3 : stage;

  return (
    <div className="max-w-7xl mx-auto px-6 -mt-8">
      <div className="bg-bg-page border border-border-primary rounded-lg overflow-hidden font-mono">
        {/* Stage progress */}
        <div className="flex items-center justify-center gap-0 bg-bg-surface h-10 border-b border-border-primary">
          {[
            { num: 1, label: 'execute' },
            { num: 2, label: 'review' },
            { num: 3, label: 'synthesize' },
          ].map((s, i) => {
            const isActive = s.num === stageNum;
            const isComplete = s.num < stageNum || stage === 'done';
            return (
              <div key={s.num} className="flex items-center">
                {i > 0 && (
                  <div className={`w-8 h-px mx-2 ${isComplete ? 'bg-green-primary' : 'bg-border-secondary'}`} />
                )}
                <div className="flex items-center gap-2 px-4">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold
                    ${isComplete ? 'bg-green-primary text-bg-page' : isActive ? 'bg-green-primary text-bg-page' : 'border border-text-muted text-text-muted'}`}
                  >
                    {isComplete ? '\u2713' : s.num}
                  </div>
                  <span className={`text-xs ${isActive ? 'text-green-primary font-medium' : isComplete ? 'text-text-secondary' : 'text-text-muted'}`}>
                    {s.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Content area */}
        <div className="min-h-[320px]">
          {/* Stage 1: Agent panes */}
          {stage === 1 && (
            <div className="flex flex-col md:flex-row md:divide-x divide-y md:divide-y-0 divide-border-primary">
              {Object.entries(agents).map(([key, agent]) => (
                <div key={key} className="flex-1 p-4 min-h-[200px] md:min-h-[300px]">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: agent.color }} />
                    <span className="text-xs text-text-primary font-medium">{agent.name}</span>
                    {agent.status === 'running' && (
                      <span className="inline-block w-1.5 h-3 rounded-sm animate-pulse" style={{ backgroundColor: agent.color }} />
                    )}
                  </div>
                  <div className="text-[11px] text-text-secondary whitespace-pre-wrap leading-relaxed overflow-hidden max-h-[260px]">
                    {agent.text}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Stage 2: Jurors */}
          {stage === 2 && (
            <div className="p-6">
              <div className="flex items-baseline gap-2 mb-4">
                <span className="text-green-primary text-sm font-medium">&gt;</span>
                <span className="text-text-primary text-sm font-medium">concilium in session</span>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                {jurors.map((juror) => (
                  <div key={juror.name} className={`bg-bg-surface border rounded-lg p-4 transition-colors ${
                    juror.status === 'complete' ? 'border-green-primary/30' : juror.status === 'evaluating' ? 'border-amber-warning/30' : 'border-border-primary'
                  }`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${
                          juror.status === 'complete' ? 'bg-green-primary' : juror.status === 'evaluating' ? 'bg-amber-warning animate-pulse' : 'bg-text-muted'
                        }`} />
                        <span className="text-xs text-text-primary">{juror.name}</span>
                      </div>
                      <span className={`text-[10px] ${
                        juror.status === 'complete' ? 'text-green-primary' : juror.status === 'evaluating' ? 'text-amber-warning' : 'text-text-muted'
                      }`}>
                        {juror.status === 'complete' ? '\u2713 complete' : juror.status === 'evaluating' ? 'reviewing...' : 'pending'}
                      </span>
                    </div>
                    <div className="h-1.5 bg-bg-page rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-200 ${juror.status === 'complete' ? 'bg-green-primary' : 'bg-amber-warning'}`}
                        style={{ width: `${juror.progress}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* Leaderboard */}
              {leaderboard.length > 0 && (
                <div className="bg-bg-surface border border-border-primary rounded-lg p-4">
                  <span className="text-xs text-text-muted mb-3 block">leaderboard</span>
                  {leaderboard.map((entry) => (
                    <div key={entry.name} className="flex items-center gap-3 py-1.5">
                      <span className={`text-sm font-bold ${entry.rank === 1 ? 'text-green-primary' : 'text-text-secondary'}`}>
                        #{entry.rank}
                      </span>
                      <span className="text-xs text-text-primary">{entry.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Stage 3: Synthesis */}
          {(stage === 3 || stage === 'done') && (
            <div className="p-6">
              <div className="flex items-baseline gap-2 mb-4">
                <span className="text-green-primary text-sm font-medium">&gt;</span>
                <span className="text-text-primary text-sm font-medium">chairman synthesizing</span>
              </div>
              <div className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed">
                {synthesis}
                {stage === 3 && (
                  <span className="inline-block w-1.5 h-3.5 bg-green-primary animate-pulse rounded-sm align-middle ml-0.5" />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="border-t border-border-primary px-4 py-2 flex items-center justify-between bg-bg-surface/50">
          <span className="text-[10px] text-text-muted">
            {stage === 'done' ? 'demo complete' : playing ? `stage ${stageNum} of 3` : 'click play to start demo'}
          </span>
          <div className="flex items-center gap-2">
            {stage === 'done' && (
              <button
                onClick={reset}
                className="text-[10px] text-text-muted hover:text-green-primary transition-colors px-2 py-1 border border-border-secondary rounded"
              >
                restart
              </button>
            )}
            <button
              onClick={() => {
                if (stage === 'done') reset();
                setPlaying(!playing);
              }}
              className="text-[10px] text-text-muted hover:text-green-primary transition-colors px-3 py-1 border border-border-secondary rounded"
            >
              {playing ? '\u23F8 Pause' : '\u25B6 Play'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

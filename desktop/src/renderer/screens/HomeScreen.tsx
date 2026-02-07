import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import Logo from "../assets/concilium-logo.svg";
import AddAgentButton from "../components/AddAgentButton";
import AgentCard from "../components/AgentCard";
import SettingsModal from "../components/SettingsModal";
import TitleBar from "../components/TitleBar";
import type {
  AgentInstance,
  AgentModelInfo,
  AgentProvider,
  CouncilConfig,
} from "../types";

const MAX_AGENTS = 3;
const MIN_AGENTS = 2;

interface HomeScreenProps {
  onStartRun: (
    runId: string,
    initialAgents: Array<{ key: string; name: string }>,
  ) => void;
}

export default function HomeScreen({ onStartRun }: HomeScreenProps) {
  const [prompt, setPrompt] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [agentInstances, setAgentInstances] = useState<AgentInstance[]>([]);
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({
    opencode: [],
    codex: [],
    claude: [],
  });
  const [defaultModels, setDefaultModels] = useState<Record<string, string>>(
    {},
  );
  const [isLoading, setIsLoading] = useState(true);

  // Settings modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [councilConfig, setCouncilConfig] = useState<CouncilConfig | null>(
    null,
  );

  // Debounced save ref
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load agent instances, model options, and council config on mount
  useEffect(() => {
    const init = async () => {
      try {
        const [instances, modelInfos, config] = await Promise.all([
          api.getAgentInstances(),
          api.discoverModels().catch((): AgentModelInfo[] => []),
          api.getConfig(),
        ]);

        // Build model options and defaults from discovery
        const opts: Record<string, string[]> = {
          opencode: [],
          codex: [],
          claude: [],
        };
        const defaults: Record<string, string> = {};

        for (const info of modelInfos) {
          opts[info.id] = info.models;
          if (info.defaultModel) {
            defaults[info.id] = info.defaultModel;
          }
        }

        setModelOptions(opts);
        setDefaultModels(defaults);

        // Fill in empty models with defaults
        const updatedInstances = instances.map((inst) => {
          if (!inst.model && defaults[inst.provider]) {
            return { ...inst, model: defaults[inst.provider] };
          }
          return inst;
        });

        setAgentInstances(updatedInstances);
        setCouncilConfig(config);

        // If models were filled in, save immediately
        if (JSON.stringify(updatedInstances) !== JSON.stringify(instances)) {
          api.saveAgentInstances(updatedInstances).catch(console.error);
        }
      } catch (err) {
        console.error("Failed to initialize:", err);
      } finally {
        setIsLoading(false);
      }
    };

    init();
  }, []);

  // Debounced save to persistence
  const saveInstances = useCallback((instances: AgentInstance[]) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      api.saveAgentInstances(instances).catch(console.error);
    }, 500);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const updateInstance = useCallback(
    (updatedInstance: AgentInstance) => {
      setAgentInstances((prev) => {
        // If provider changed and model is empty, use default
        const instance =
          !updatedInstance.model && defaultModels[updatedInstance.provider]
            ? {
                ...updatedInstance,
                model: defaultModels[updatedInstance.provider],
              }
            : updatedInstance;

        const next = prev.map((inst) =>
          inst.instanceId === instance.instanceId ? instance : inst,
        );
        saveInstances(next);
        return next;
      });
    },
    [defaultModels, saveInstances],
  );

  const removeInstance = useCallback(
    (instanceId: string) => {
      setAgentInstances((prev) => {
        if (prev.length <= MIN_AGENTS) return prev;
        const next = prev.filter((inst) => inst.instanceId !== instanceId);
        saveInstances(next);
        return next;
      });
    },
    [saveInstances],
  );

  const addInstance = useCallback(
    (provider: AgentProvider) => {
      setAgentInstances((prev) => {
        if (prev.length >= MAX_AGENTS) return prev;

        const newInstance: AgentInstance = {
          instanceId: crypto.randomUUID(),
          provider,
          model: defaultModels[provider] ?? "",
          enabled: true,
        };

        const next = [...prev, newInstance];
        saveInstances(next);
        return next;
      });
    },
    [defaultModels, saveInstances],
  );

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || isStarting) return;

    const enabledInstances = agentInstances.filter((inst) => inst.enabled);
    if (enabledInstances.length < MIN_AGENTS) return;

    setIsStarting(true);
    try {
      // Pass full instance data to backend for multi-instance support
      // Cast to `any` to handle both old (string) and new ({ runId, initialAgents })
      // return formats — the renderer may hot-reload while main process still
      // returns the old string format if it wasn't restarted.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await api.startRun({
        prompt: prompt.trim(),
        agents: enabledInstances.map((inst) => inst.provider),
        mode: "advanced",
        agentInstances: enabledInstances,
      });
      const runId = typeof result === "string" ? result : result.runId;
      const initialAgents =
        typeof result === "string" ? [] : (result.initialAgents ?? []);
      onStartRun(runId, initialAgents);
    } catch (err) {
      console.error("Failed to start run:", err);
      setIsStarting(false);
    }
  }, [prompt, agentInstances, isStarting, onStartRun]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const enabledCount = agentInstances.filter((inst) => inst.enabled).length;
  const canRun = prompt.trim() && enabledCount >= MIN_AGENTS && !isStarting;

  if (isLoading) {
    return (
      <div className="flex flex-col h-screen bg-bg-page overflow-hidden">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-text-muted">
            <div className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center animate-[spin-slow_3s_linear_infinite]">
              <div className="w-8 h-8 rounded-full border-t-2 border-green-primary" />
            </div>
            <span className="text-xs font-mono text-text-muted/70">
              Initializing system...
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-bg-page overflow-hidden selection:bg-green-primary/30 selection:text-green-primary relative">
      <TitleBar />

      {/* 3D Hero Background removed */}

      <main className="flex-1 flex flex-col px-8 md:px-12 pt-8 pb-8 max-w-5xl mx-auto w-full relative z-10">
        {/* Header Branding */}
        <div className="flex items-center justify-between mb-12">
          <div className="flex items-center gap-4 opacity-90">
            <div className="w-10 h-10 flex items-center justify-center bg-white/5 rounded border border-white/10">
              <img
                src={Logo}
                alt="Concilium"
                className="w-6 h-6 object-contain opacity-90"
              />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white/90 font-mono">
                Concilium
              </h1>
            </div>
          </div>

          {/* Council Config Summary */}
          <div className="flex items-center gap-3">
            {councilConfig && (
              <div className="hidden md:flex items-center gap-4 text-[11px] font-mono text-text-muted">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-info"></span>
                  <span>{councilConfig.councilModels.length} jurors</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-warning"></span>
                  <span className="truncate max-w-[120px]">
                    {councilConfig.chairmanModel.split("/").pop()}
                  </span>
                </div>
                {!councilConfig.hasApiKey && (
                  <span className="text-red-error uppercase tracking-wide text-[10px]">
                    No API Key
                  </span>
                )}
              </div>
            )}
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="flex items-center gap-2 px-3 py-2 rounded bg-white/5 border border-white/10 text-[11px] font-medium text-text-secondary hover:bg-white/10 hover:border-white/20 transition-colors"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              Settings
            </button>
          </div>
        </div>

        {/* Prompt section */}
        <div className="w-full mb-12 group">
          <div className="flex items-baseline justify-between mb-4 border-b border-white/5 pb-2">
            <div className="flex items-center gap-2">
              <span className="text-green-primary text-xs font-bold font-mono">
                01
              </span>
              <span className="text-text-secondary text-xs font-bold tracking-wide">
                Prompt
              </span>
            </div>
          </div>

          <div className="relative">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Design a distributed key-value store with strong consistency guarantees. Debate the trade-offs between Paxos and Raft consensus algorithms, and propose a sharding strategy for petabyte-scale data..."
              rows={4}
              className="relative w-full bg-bg-surface border border-white/5 rounded px-5 py-4 text-sm text-text-primary placeholder:text-text-muted/30 resize-y focus:outline-none focus:border-green-primary/50 transition-colors font-mono leading-relaxed"
              autoFocus
            />
          </div>
        </div>

        {/* Agent selection */}
        <div className="w-full mb-auto">
          <div className="flex items-baseline justify-between mb-4 border-b border-white/5 pb-2">
            <div className="flex items-center gap-2">
              <span className="text-blue-info text-xs font-bold font-mono">
                02
              </span>
              <span className="text-text-secondary text-xs font-bold tracking-wide">
                Council composition
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {agentInstances.map((instance) => (
              <AgentCard
                key={instance.instanceId}
                instance={instance}
                modelOptions={modelOptions[instance.provider] ?? []}
                canRemove={agentInstances.length > MIN_AGENTS}
                onUpdate={updateInstance}
                onRemove={() => removeInstance(instance.instanceId)}
              />
            ))}
            {agentInstances.length < MAX_AGENTS && (
              <AddAgentButton onAdd={addInstance} />
            )}
          </div>

          {/* Validation message */}
          {enabledCount < MIN_AGENTS && (
            <div className="mt-4 flex items-center gap-2 p-3 rounded bg-amber-warning/10 border border-amber-warning/20">
              <svg
                className="w-4 h-4 text-amber-warning"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <p className="text-[11px] font-mono text-amber-warning">
                Warning: Quorum not met. Enable at least {MIN_AGENTS} agents.
              </p>
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="w-full mt-auto pt-12 border-t border-white/5 pb-8">
          <div className="flex items-center justify-between gap-6">
            <div className="flex items-center gap-6 text-[11px] text-text-muted font-mono"></div>
            <button
              onClick={handleSubmit}
              disabled={!canRun}
              className={`relative flex items-center justify-center gap-3 px-8 py-4 rounded text-sm font-semibold transition-all min-w-[200px] bg-green-primary/10 border border-green-primary/30 text-green-primary hover:bg-green-primary/20 hover:border-green-primary/50
                ${!canRun ? "opacity-50 cursor-not-allowed bg-white/5 border-white/10 text-text-muted hover:bg-white/5 hover:border-white/10" : ""}`}
            >
              {isStarting ? (
                <>
                  <svg
                    className="animate-spin w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  <span>Initializing...</span>
                </>
              ) : (
                <div className="flex items-center text-xs gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-text-tertiary text-[9px]">
                    Cmd+Enter
                  </kbd>{" "}
                  Start run
                </div>
              )}
            </button>
          </div>
        </div>
      </main>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onConfigUpdate={setCouncilConfig}
        initialConfig={councilConfig}
      />
    </div>
  );
}

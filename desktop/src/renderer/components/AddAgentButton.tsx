import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { AgentProvider } from '../types';

const PROVIDERS: { id: AgentProvider; name: string; color: string }[] = [
  { id: 'opencode', name: 'opencode', color: 'var(--color-provider-opencode)' },
  { id: 'codex', name: 'codex', color: 'var(--color-provider-codex)' },
  { id: 'claude', name: 'claude', color: 'var(--color-provider-claude)' },
];

interface AddAgentButtonProps {
  onAdd: (provider: AgentProvider) => void;
}

export default function AddAgentButton({ onAdd }: AddAgentButtonProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (provider: AgentProvider) => {
    onAdd(provider);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="flex flex-col items-center justify-center rounded border border-dashed border-white/10 bg-transparent hover:bg-white/5 hover:border-white/20 transition-all duration-300 min-h-[140px] group relative"
        >
          <div className="w-10 h-10 rounded-full border border-white/10 group-hover:border-white/30 flex items-center justify-center transition-colors mb-3">
             <span className="text-xl font-light text-text-muted group-hover:text-text-primary transition-colors">+</span>
          </div>
          <span className="text-[11px] tracking-wide text-text-muted group-hover:text-text-secondary transition-colors font-mono">
            Add member
          </span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-48 bg-[#121212] border border-white/10 rounded shadow-2xl overflow-hidden py-1 animate-in fade-in zoom-in-95 duration-200"
          sideOffset={8}
          align="center"
        >
          <div className="px-3 py-2 text-[10px] text-text-muted tracking-wide border-b border-white/5 mb-1 font-mono">
            Select provider
          </div>
          {PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              onClick={() => handleSelect(provider.id)}
              className="flex items-center gap-3 w-full px-3 py-2 text-[11px] font-mono tracking-wide text-text-secondary hover:bg-white/5 hover:text-text-primary transition-colors text-left"
            >
              <div
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: provider.color }}
              />
              {provider.name}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

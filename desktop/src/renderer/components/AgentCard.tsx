import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import ModelCombobox from './ModelCombobox';
import type { AgentInstance, AgentProvider } from '../types';

const PROVIDERS: { id: AgentProvider; name: string; color: string }[] = [
  { id: 'opencode', name: 'opencode', color: 'var(--color-provider-opencode)' },
  { id: 'codex', name: 'codex', color: 'var(--color-provider-codex)' },
  { id: 'claude', name: 'claude', color: 'var(--color-provider-claude)' },
];

function getProviderColor(provider: AgentProvider): string {
  return PROVIDERS.find((p) => p.id === provider)?.color ?? 'var(--color-text-muted)';
}

interface AgentCardProps {
  instance: AgentInstance;
  modelOptions: string[];
  canRemove: boolean;
  onUpdate: (instance: AgentInstance) => void;
  onRemove: () => void;
}


export default function AgentCard({
  instance,
  modelOptions,
  canRemove,
  onUpdate,
  onRemove,
}: AgentCardProps) {
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState('');

  const providerColor = getProviderColor(instance.provider);
  
  const handleProviderChange = (newProvider: AgentProvider) => {
    onUpdate({
      ...instance,
      provider: newProvider,
      model: '', // Reset model when provider changes - will use default
    });
    setProviderOpen(false);
    setProviderSearch('');
  };

  const handleModelChange = (model: string) => {
    onUpdate({ ...instance, model });
  };

  const handleToggle = () => {
    onUpdate({ ...instance, enabled: !instance.enabled });
  };

  return (
    <div
      className={`flex flex-col rounded border transition-all duration-300 relative overflow-hidden group ${
        instance.enabled 
          ? 'bg-bg-surface border-white/10' 
          : 'bg-bg-surface/50 border-white/5 opacity-70'
      }`}
    >
      {/* Card header: provider selector + remove button */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 relative z-10">
        <Popover.Root open={providerOpen} onOpenChange={setProviderOpen}>
          <Popover.Trigger asChild>
            <button
              className="flex items-center gap-2 hover:bg-white/5 px-2 py-1 -ml-2 rounded transition-colors"
              aria-expanded={providerOpen}
            >
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: providerColor }}
              />
              <span
                className="text-xs font-semibold tracking-wide"
                style={{ color: instance.enabled ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}
              >
                {instance.provider}
              </span>
              <svg
                className={`w-3 h-3 text-text-muted transition-transform ${providerOpen ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </Popover.Trigger>

          <Popover.Portal>
            <Popover.Content
              className="z-50 w-48 bg-[#121212] border border-border-secondary rounded-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
              sideOffset={4}
              align="start"
            >
              <Command className="flex flex-col" shouldFilter={true}>
                <div className="flex items-center border-b border-border-primary px-3">
                  <svg className="w-3 h-3 text-text-muted shrink-0 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <Command.Input
                    value={providerSearch}
                    onValueChange={setProviderSearch}
                    placeholder="Search providers..."
                    className="w-full bg-transparent py-2.5 text-[10px] text-text-primary placeholder:text-text-muted outline-none font-mono uppercase"
                  />
                </div>

                <Command.List className="max-h-48 overflow-y-auto py-1">
                  <Command.Empty className="px-3 py-2 text-[10px] text-text-muted font-mono">
                    NO PROVIDERS FOUND.
                  </Command.Empty>
                  {PROVIDERS.map((provider) => (
                    <Command.Item
                      key={provider.id}
                      value={provider.name}
                      onSelect={() => handleProviderChange(provider.id)}
                      className={`flex items-center gap-2 px-3 py-2 text-[11px] font-mono cursor-pointer transition-colors tracking-wide outline-none
                        [&[data-selected="true"]]:bg-white/5
                        ${instance.provider === provider.id ? 'text-text-primary' : 'text-text-secondary'}`}
                    >
                      <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: provider.color }}
                      />
                      {provider.name}
                      {instance.provider === provider.id && (
                        <svg
                          className="w-3 h-3 ml-auto shrink-0"
                          style={{ color: provider.color }}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </Command.Item>
                  ))}
                </Command.List>
              </Command>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        {/* Remove button */}
        {canRemove && (
          <button
            onClick={onRemove}
            className="p-1.5 rounded-md hover:bg-white/10 text-text-muted hover:text-red-error transition-colors"
            title="Decommission Agent"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Model combobox */}
      <div className="px-4 pb-2 relative z-10">
          <ModelCombobox
          value={instance.model}
          options={modelOptions}
          onSelect={handleModelChange}
          placeholder="Select model..."
        />
      </div>

      {/* Status + Toggle */}
      <div className="flex items-center justify-between px-4 pb-4 mt-2 relative z-10">
        <div className="flex items-center gap-2">
          <div 
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: instance.enabled ? '#22C55E' : 'var(--color-text-muted)' }}
          />
          <span 
            className="text-[10px] font-semibold tracking-wide uppercase"
            style={{ color: instance.enabled ? '#22C55E' : 'var(--color-text-muted)' }}
          >
            {instance.enabled ? 'Active' : 'Inactive'}
          </span>
        </div>
        
        <button
          onClick={handleToggle}
          className={`w-10 h-5 rounded-full transition-colors relative focus:outline-none ${
            instance.enabled ? 'bg-white/20' : 'bg-white/5'
          }`}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full transition-all duration-300 shadow-sm ${
              instance.enabled ? 'left-[22px] bg-[#22C55E]' : 'left-0.5 bg-text-muted'
            }`}
          />
        </button>
      </div>
    </div>
  );
}


import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';

interface ModelComboboxProps {
  value: string;
  options: string[];
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function ModelCombobox({
  value,
  options,
  onSelect,
  placeholder = 'select model...',
  disabled = false,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightedValue, setHighlightedValue] = useState(value);

  const handleValueChange = (newValue: string) => {
    setHighlightedValue(newValue);
    // Select immediately on arrow key navigation
    if (newValue && newValue !== value) {
      onSelect(newValue);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button
          className={`flex items-center justify-between w-full px-3 py-2 rounded text-[10px] transition-colors
            border border-white/5 hover:border-white/10
            ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/5'}
            bg-bg-input text-text-secondary`}
          aria-expanded={open}
        >
          <span className="truncate font-mono text-[11px] tracking-wide">
            {value || placeholder}
          </span>
          <svg
            className={`w-3 h-3 ml-2 text-text-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-[var(--radix-popover-trigger-width)] bg-[#121212] border border-white/10 rounded shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
          sideOffset={4}
          align="start"
        >
          <Command
            className="flex flex-col"
            shouldFilter={true}
            loop={true}
            value={highlightedValue}
            onValueChange={handleValueChange}
          >
            <div className="flex items-center border-b border-white/5 px-2">
              <svg className="w-3 h-3 text-text-muted shrink-0 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search models..."
                className="w-full bg-transparent py-2.5 text-[11px] text-text-primary placeholder:text-text-muted outline-none font-mono"
              />
            </div>

            <Command.List className="max-h-48 overflow-y-auto py-1">
              <Command.Empty className="px-3 py-2 text-[11px] text-text-muted font-mono">
                No models found.
              </Command.Empty>
              {options.map((model) => (
                <Command.Item
                  key={model}
                  value={model}
                  onSelect={() => {
                    onSelect(model);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={`flex items-center gap-2 px-3 py-2 text-[11px] font-mono cursor-pointer transition-colors outline-none tracking-wide
                    hover:bg-white/5 hover:text-text-primary 
                    data-[selected=true]:bg-white/5 data-[selected=true]:text-text-primary
                    ${value === model ? 'text-green-primary' : 'text-text-secondary'}`}
                >
                  <div className={`w-1 h-1 rounded-full shrink-0 ${value === model ? 'bg-green-primary' : 'bg-transparent'}`} />
                  {model}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

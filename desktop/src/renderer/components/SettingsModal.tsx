/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { useState, useEffect, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import type { CouncilConfig } from '../types';
import type { OpenRouterModelInfo } from '../../preload/preload';
import { api } from '../api';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigUpdate: (config: CouncilConfig) => void;
  initialConfig: CouncilConfig | null;
}

interface ModelSelection {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  pricing: string;
}

const MAX_COUNCIL_MODELS = 5;
const MIN_COUNCIL_MODELS = 1;

export default function SettingsModal({
  isOpen,
  onClose,
  onConfigUpdate,
  initialConfig,
}: SettingsModalProps) {
  // State
  const [activeTab, setActiveTab] = useState('api');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [chairmanModel, setChairmanModel] = useState('');
  const [councilModels, setCouncilModels] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelSelection[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKeySetInEnv, setApiKeySetInEnv] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  // Search state for council models
  const [councilSearch, setCouncilSearch] = useState('');

  // Load initial config whenever it changes or modal opens
  useEffect(() => {
    if (initialConfig && isOpen) {
      setChairmanModel(initialConfig.chairmanModel);
      setCouncilModels(initialConfig.councilModels);
      setApiKeySetInEnv(initialConfig.apiKeySetInEnv);
      
      // If API key is set in env, clear local input
      if (initialConfig.apiKeySetInEnv) {
        setApiKey('');
      }
    }
  }, [initialConfig, isOpen]);

  // Fetch models
  const fetchModels = useCallback(async (key: string) => {
    // Determine effective key: user input or existing key if not overridden by input
    const effectiveKey = key || (initialConfig?.hasApiKey && !key ? 'use-stored-key' : '');
    
    // If no key available at all
    if (!effectiveKey && !initialConfig?.hasApiKey) {
      setError('Please enter an API key first');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Pass key only if explicitly provided, otherwise backend uses stored key
      // If 'use-stored-key' marker, pass empty string so backend uses stored
      const keyToUse = key || ''; 
      const models = await api.fetchOpenRouterModels(keyToUse);
      
      const selections = models.map((m: OpenRouterModelInfo) => ({
        id: m.id,
        name: m.name,
        provider: getProviderFromId(m.id),
        contextLength: m.context_length,
        pricing: formatPricing(m.pricing.prompt, m.pricing.completion),
      }));
      setAvailableModels(selections);
    } catch (err) {
      setError('Failed to fetch models. Please check your API key.');
      console.error('Failed to fetch models:', err);
    } finally {
      setIsLoading(false);
    }
  }, [initialConfig?.hasApiKey]);

  // Auto-fetch models when opening models tab
  useEffect(() => {
    if (activeTab === 'models' && isOpen && availableModels.length === 0) {
      fetchModels(apiKey);
    }
  }, [activeTab, isOpen, apiKey, availableModels.length, fetchModels]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const configToSave: { chairmanModel?: string; councilModels?: string[]; apiKey?: string } = {
        chairmanModel,
        councilModels,
      };
      
      if (apiKey) {
        configToSave.apiKey = apiKey;
      }

      await api.saveCouncilConfig(configToSave);
      
      // Refresh config
      const newConfig = await api.getConfig();
      onConfigUpdate(newConfig);
      onClose();
    } catch (err) {
      setError('Failed to save configuration');
      console.error('Failed to save config:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const toggleCouncilModel = (modelId: string) => {
    setCouncilModels((prev) => {
      if (prev.includes(modelId)) {
        if (prev.length <= MIN_COUNCIL_MODELS) {
          return prev; // Don't allow removing last model
        }
        return prev.filter((id) => id !== modelId);
      }
      if (prev.length >= MAX_COUNCIL_MODELS) {
        return prev; // Don't allow adding beyond max
      }
      return [...prev, modelId];
    });
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 animate-in fade-in duration-200" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[85vh] bg-[#121212] border border-white/10 rounded-lg shadow-2xl z-50 flex flex-col animate-in zoom-in-95 fade-in duration-200 font-mono">
          
              {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-white/[0.02]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded bg-white/5 border border-white/10 flex items-center justify-center text-green-primary">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div>
                <Dialog.Title className="text-xs font-bold text-white uppercase tracking-widest">
                  Council Configuration
                </Dialog.Title>
                <p className="text-[10px] text-text-secondary uppercase tracking-wider opacity-80">
                  Manage API Access & Model Selection
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded hover:bg-white/5 text-text-muted hover:text-white transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Tabs */}
          <Tabs.Root value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
            <div className="px-6 py-4 border-b border-white/10 bg-bg-page/50">
              <Tabs.List className="flex gap-2">
                <Tabs.Trigger
                  value="api"
                  className="px-4 py-2 rounded text-[10px] font-bold tracking-widest uppercase transition-all
                    data-[state=active]:bg-white/10 data-[state=active]:text-white data-[state=active]:border-white/10 border border-transparent
                    text-text-muted hover:text-text-secondary hover:bg-white/5"
                >
                  API Access
                </Tabs.Trigger>
                <Tabs.Trigger
                  value="models"
                  className="px-4 py-2 rounded text-[10px] font-bold tracking-widest uppercase transition-all
                    data-[state=active]:bg-white/10 data-[state=active]:text-white data-[state=active]:border-white/10 border border-transparent
                    text-text-muted hover:text-text-secondary hover:bg-white/5"
                >
                  Model Selection
                </Tabs.Trigger>
              </Tabs.List>
            </div>

            {/* API Tab */}
            <Tabs.Content value="api" className="flex-1 p-6 overflow-y-auto outline-none">
              <div className="space-y-8 w-full">
                {/* API Key Section */}
                <div className="w-full">
                  <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-widest mb-3">
                    OpenRouter API Key
                  </label>
                  <div className="relative group w-full">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={initialConfig?.hasApiKey ? '••••••••••••••••••••••••••' : 'ENTER API KEY...'}
                      disabled={apiKeySetInEnv}
                      className="w-full bg-bg-input border border-white/5 rounded px-4 py-3 text-[10px] text-white placeholder:text-text-muted/50 focus:outline-none focus:border-white/20 transition-colors font-mono tracking-wide uppercase disabled:opacity-50 disabled:cursor-not-allowed hover:border-white/10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      disabled={apiKeySetInEnv}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-white/10 text-text-muted hover:text-white transition-colors disabled:opacity-50"
                    >
                      {showApiKey ? (
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                  {apiKeySetInEnv ? (
                    <div className="mt-3 flex items-center gap-2 text-[10px] text-blue-info/80 font-mono tracking-wide">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>Key managed via environment variables</span>
                    </div>
                  ) : (
                    <p className="mt-3 text-[10px] text-text-muted font-mono tracking-wide opacity-60">
                      Keys are encrypted securely in your system keychain.
                    </p>
                  )}
                </div>

                {/* Test Connection Button */}
                <div>
                  <button
                    onClick={() => fetchModels(apiKey)}
                    disabled={isLoading || (!apiKey && !initialConfig?.hasApiKey)}
                    className="flex items-center gap-2 px-4 py-2.5 rounded bg-white/5 border border-white/5 text-[10px] font-bold uppercase tracking-widest text-text-secondary hover:bg-white/10 hover:border-white/10 hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed w-full justify-center group"
                  >
                    {isLoading ? (
                      <>
                        <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>Testing Connection...</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5 transition-transform group-hover:scale-110" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        <span>Test Connection</span>
                      </>
                    )}
                  </button>
                  {error && (
                    <div className="mt-3 flex items-center gap-2 text-red-error text-[10px] font-mono tracking-wide">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      {error}
                    </div>
                  )}
                </div>

                {/* Info Box */}
                <div className="p-4 rounded bg-white/[0.02] border border-white/5">
                  <div className="flex items-start gap-3">
                    <svg className="w-4 h-4 text-blue-info mt-0.5 shrink-0 opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <p className="text-[10px] font-bold text-text-secondary uppercase tracking-widest mb-1.5">
                        OpenRouter Provider
                      </p>
                      <p className="text-[10px] text-text-muted leading-relaxed font-mono opacity-70">
                        Access state-of-the-art models via a unified API. Get your key from{' '}
                        <a
                          href="https://openrouter.ai/keys"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-info hover:text-blue-400 hover:underline transition-colors"
                        >
                          openrouter.ai/keys
                        </a>
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </Tabs.Content>

            {/* Models Tab */}
            <Tabs.Content value="models" className="flex-1 overflow-hidden flex flex-col outline-none">
              {/* Chairman Selection */}
              <div className="px-6 py-5 border-b border-white/10 bg-white/[0.01]">
                <div className="flex items-center gap-2 mb-3">
                   <div className="w-1.5 h-1.5 rounded-full bg-amber-warning" />
                   <label className="text-[10px] font-bold text-text-secondary uppercase tracking-widest">
                    Chairman Model
                  </label>
                </div>
                
                <ModelSelector
                  value={chairmanModel}
                  options={availableModels}
                  onSelect={setChairmanModel}
                  placeholder="SELECT CHAIRMAN..."
                  disabled={isLoading}
                />
                <p className="mt-2 text-[10px] text-text-muted font-mono uppercase tracking-wide opacity-50 pl-3.5">
                  Synthesizes final answers from council deliberations
                </p>
              </div>

              {/* Council Models Selection */}
              <div className="flex-1 overflow-hidden flex flex-col min-h-0 bg-bg-page/20">
                <div className="px-6 py-3 border-b border-white/5 flex flex-col gap-3 bg-white/[0.02]">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-info" />
                      <label className="text-[10px] font-bold text-text-secondary uppercase tracking-widest">
                        Council Jurors ({councilModels.length}/{MAX_COUNCIL_MODELS})
                      </label>
                    </div>
                    <span className="text-[10px] text-text-muted font-mono uppercase tracking-wide opacity-50">
                      Required: {MIN_COUNCIL_MODELS}-{MAX_COUNCIL_MODELS}
                    </span>
                  </div>
                  
                  {/* Search Input */}
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
                      <svg className="w-3 h-3 text-text-muted opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                    </div>
                    <input
                      type="text"
                      value={councilSearch}
                      onChange={(e) => setCouncilSearch(e.target.value)}
                      placeholder="SEARCH JURORS..."
                      className="w-full bg-bg-input border border-white/5 rounded pl-8 pr-3 py-1.5 text-[10px] text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-white/10 transition-colors font-mono tracking-wide uppercase"
                    />
                  </div>
                </div>

                {isLoading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-3 text-text-muted">
                      <div className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center animate-[spin-slow_3s_linear_infinite]">
                        <div className="w-5 h-5 rounded-full border-t-2 border-green-primary" />
                      </div>
                      <span className="text-[10px] font-mono uppercase tracking-widest opacity-70">Loading models...</span>
                    </div>
                  </div>
                ) : availableModels.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <p className="text-[10px] text-text-muted font-mono uppercase tracking-wide mb-3">No models loaded</p>
                      <button
                        onClick={() => fetchModels(apiKey)}
                        className="text-[10px] text-blue-info hover:text-white hover:underline uppercase tracking-wider transition-colors"
                      >
                        Reload Models
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto px-6 py-4 custom-scrollbar">
                    <div className="grid grid-cols-1 gap-2">
                      {availableModels
                        .filter(m => 
                          !councilSearch || 
                          m.name.toLowerCase().includes(councilSearch.toLowerCase()) || 
                          m.provider.toLowerCase().includes(councilSearch.toLowerCase())
                        )
                        .map((model) => {
                        const isSelected = councilModels.includes(model.id);
                        const canSelect = isSelected || councilModels.length < MAX_COUNCIL_MODELS;
                        
                        return (
                          <button
                            key={model.id}
                            onClick={() => canSelect && toggleCouncilModel(model.id)}
                            disabled={!canSelect && !isSelected}
                            className={`flex items-center gap-4 p-3 rounded border transition-all text-left group
                              ${isSelected 
                                ? 'bg-green-primary/5 border-green-primary/20' 
                                : canSelect
                                  ? 'bg-bg-input border-white/5 hover:border-white/10 hover:bg-white/[0.03]'
                                  : 'bg-white/[0.01] border-white/5 opacity-40 cursor-not-allowed'
                              }`}
                          >
                            <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors
                              ${isSelected 
                                ? 'bg-green-primary border-green-primary shadow-sm shadow-green-primary/20' 
                                : 'border-white/20 group-hover:border-white/40 bg-transparent'
                              }`}
                            >
                              {isSelected && (
                                <svg className="w-2.5 h-2.5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className={`text-[11px] font-bold font-mono uppercase tracking-wide truncate transition-colors ${
                                  isSelected ? 'text-green-primary' : 'text-text-primary'
                                }`}>
                                  {model.name}
                                </span>
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 border border-white/5 text-text-muted shrink-0 uppercase tracking-wider">
                                  {model.provider}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 text-[9px] text-text-muted font-mono tracking-wide opacity-70">
                                <span>{(model.contextLength / 1000).toFixed(0)}K CTX</span>
                                <span className="w-1 h-1 rounded-full bg-white/10" />
                                <span>{model.pricing}</span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </Tabs.Content>
          </Tabs.Root>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-white/10 bg-bg-page/50">
            <div className="text-[10px] text-text-muted font-mono uppercase tracking-wide">
              {activeTab === 'models' && (
                <span className={councilModels.length < MIN_COUNCIL_MODELS ? 'text-amber-warning' : 'opacity-70'}>
                  {councilModels.length} SELECTED
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded text-[10px] font-bold uppercase tracking-widest text-text-muted hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || councilModels.length < MIN_COUNCIL_MODELS || !chairmanModel}
                className="flex items-center gap-2 px-6 py-2 rounded bg-white/10 border border-white/10 text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white/20 hover:border-white/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-black/20"
              >
                {isSaving ? (
                  <>
                    <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Model Selector Component (Styled like ModelCombobox)
interface ModelSelectorProps {
  value: string;
  options: ModelSelection[];
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

function ModelSelector({ value, options, onSelect, placeholder = 'Select...', disabled = false }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selectedModel = options.find((m) => m.id === value);

  const filteredOptions = options.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.provider.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="relative">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={`flex items-center justify-between w-full px-3 py-2.5 rounded text-[10px] transition-colors
          border border-white/5 hover:border-white/10
          ${disabled ? 'opacity-40 cursor-not-allowed bg-white/[0.02]' : 'hover:bg-white/5 bg-bg-input'}
          text-text-secondary`}
      >
        {selectedModel ? (
          <div className="flex-1 min-w-0 flex items-center justify-between gap-4">
             <span className="truncate font-mono uppercase tracking-wide text-text-primary">
              {selectedModel.name}
            </span>
             <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 border border-white/5 text-text-muted shrink-0 uppercase tracking-wider">
              {selectedModel.provider}
            </span>
          </div>
        ) : (
          <span className="truncate font-mono uppercase tracking-wide text-text-muted">{placeholder}</span>
        )}
        <svg
          className={`w-3 h-3 ml-2 text-text-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && !disabled && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute top-full left-0 right-0 mt-2 bg-[#121212] border border-white/10 rounded shadow-2xl z-50 max-h-64 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center border-b border-white/5 px-2 bg-white/[0.02]">
              <svg className="w-3 h-3 text-text-muted shrink-0 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="SEARCH MODELS..."
                className="w-full bg-transparent py-2.5 text-[10px] text-text-primary placeholder:text-text-muted outline-none font-mono uppercase tracking-wide"
                autoFocus
              />
            </div>
            <div className="overflow-y-auto flex-1 py-1 custom-scrollbar">
              {filteredOptions.length === 0 ? (
                <div className="px-3 py-2 text-[10px] text-text-muted font-mono uppercase tracking-wide text-center opacity-70">NO MODELS FOUND</div>
              ) : (
                filteredOptions.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => {
                      onSelect(model.id);
                      setOpen(false);
                      setSearch('');
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 text-[10px] font-mono cursor-pointer transition-colors outline-none uppercase tracking-wide text-left group
                      hover:bg-white/5 hover:text-text-primary 
                      ${value === model.id ? 'bg-white/5 text-green-primary' : 'text-text-secondary'}`}
                  >
                    <div className="flex items-center gap-2 overflow-hidden">
                       <div className={`w-1 h-1 rounded-full shrink-0 ${value === model.id ? 'bg-green-primary' : 'bg-transparent group-hover:bg-white/20'}`} />
                       <span className="truncate">{model.name}</span>
                    </div>
                    <span className="text-[9px] text-text-muted opacity-50 shrink-0 ml-2">{model.provider}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Helper functions (same as before)
function getProviderFromId(modelId: string): string {
  const provider = modelId.split('/')[0];
  const providerMap: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    'meta-llama': 'Meta',
    mistralai: 'Mistral',
    deepseek: 'DeepSeek',
    qwen: 'Qwen',
    'x-ai': 'xAI',
    cohere: 'Cohere',
    perplexity: 'Perplexity',
    nvidia: 'NVIDIA',
    microsoft: 'Microsoft',
    amazon: 'Amazon',
  };
  return providerMap[provider] || provider;
}

function formatPricing(prompt: number, completion: number): string {
  const format = (n: number) => {
    if (n === 0) return 'Free';
    // Handle very small non-zero numbers that might look like 0.00
    if (n > 0 && n < 0.01) return '< $0.01';
    return `$${n.toFixed(2)}`;
  };
  return `${format(prompt)} / ${format(completion)}`;
}


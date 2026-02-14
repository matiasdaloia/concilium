/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { useVoiceDictation } from '../hooks/useVoiceDictation';

interface VoiceInputButtonProps {
  onTranscript: (transcript: string, isFinal: boolean) => void;
  onStop?: () => void;
  disabled?: boolean;
}

export default function VoiceInputButton({ 
  onTranscript, 
  onStop,
  disabled = false 
}: VoiceInputButtonProps) {
  const handleTranscript = (transcript: string, isFinal: boolean) => {
    onTranscript(transcript, isFinal);
  };

  const handleError = (error: string) => {
    console.error('[Voice] Error:', error);
  };

  const handleStop = () => {
    onStop?.();
  };

  const { 
    isListening, 
    isSupported, 
    isProcessing,
    error, 
    startListening,
    stopListening 
  } = useVoiceDictation({
    onTranscript: handleTranscript,
    onError: handleError,
    onStop: handleStop,
  });

  if (!isSupported) {
    return null;
  }

  const getButtonLabel = () => {
    if (isProcessing) return 'Processing...';
    if (isListening) return 'Stop';
    if (error) return 'Retry';
    return 'Dictate';
  };

  const getErrorMessage = () => {
    if (error?.includes('Microphone permission denied')) {
      return 'Please allow microphone access in System Preferences';
    }
    if (error?.includes('not supported')) {
      return 'Voice dictation not supported in this browser';
    }
    if (error) return error;
    return null;
  };

  const errorMessage = getErrorMessage();

  const handleClick = async () => {
    if (isListening) {
      stopListening();
    } else {
      await startListening();
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={disabled || isProcessing}
        className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-all ${
          isListening
            ? 'bg-red-500/20 text-red-400 border border-red-500/50 animate-pulse'
            : isProcessing
            ? 'bg-blue-500/20 text-blue-400 border border-blue-500/50 cursor-wait'
            : error
            ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20'
            : 'bg-white/5 border border-white/10 text-text-secondary hover:bg-white/10 hover:border-white/20'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
        title={isListening ? 'Stop recording' : errorMessage || 'Start voice dictation'}
        type="button"
      >
        {isListening ? (
          <>
            <svg
              className="w-4 h-4"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
            <span>Stop</span>
          </>
        ) : isProcessing ? (
          <>
            <svg
              className="w-4 h-4 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            <span>Processing...</span>
          </>
        ) : (
          <>
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
            </svg>
            <span>{getButtonLabel()}</span>
          </>
        )}
      </button>
      
      {errorMessage && !isListening && !isProcessing && (
        <span className="text-[10px] text-amber-400/80 max-w-[140px] text-right leading-tight">
          {errorMessage}
        </span>
      )}
    </div>
  );
}

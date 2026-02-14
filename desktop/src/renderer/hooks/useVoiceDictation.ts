/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseVoiceDictationOptions {
  onTranscript: (transcript: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
  onStop?: () => void;
}

interface UseVoiceDictationReturn {
  isListening: boolean;
  isSupported: boolean;
  isProcessing: boolean;
  error: string | null;
  permissionState: PermissionState | null;
  startListening: () => Promise<void>;
  stopListening: () => void;
}

export function useVoiceDictation(
  options: UseVoiceDictationOptions
): UseVoiceDictationReturn {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState<PermissionState | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const optionsRef = useRef(options);

  // Keep options ref updated
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // Check if MediaRecorder is supported
  useEffect(() => {
    const checkSupport = () => {
      const supported = typeof window !== 'undefined' && 
        typeof window.MediaRecorder !== 'undefined' &&
        typeof navigator !== 'undefined' &&
        typeof navigator.mediaDevices !== 'undefined';
      
      console.log('[Voice Debug] MediaRecorder supported:', supported);
      setIsSupported(supported);
    };

    checkSupport();
  }, []);

  // Check microphone permissions
  useEffect(() => {
    const checkPermissions = async () => {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          console.log('[Voice Debug] Microphone permission state:', result.state);
          setPermissionState(result.state as PermissionState);
          
          result.addEventListener('change', () => {
            console.log('[Voice Debug] Permission state changed:', result.state);
            setPermissionState(result.state as PermissionState);
          });
        } else {
          console.log('[Voice Debug] Permissions API not supported');
        }
      } catch (err) {
        console.error('[Voice Debug] Error checking permissions:', err);
      }
    };
    
    checkPermissions();
  }, []);

  // Start recording
  const startListening = useCallback(async () => {
    console.log('[Voice Debug] Starting voice recording...');
    
    if (!isSupported) {
      setError('Voice recording not supported in this browser');
      optionsRef.current.onError?.('Voice recording not supported');
      return;
    }

    try {
      setError(null);
      audioChunksRef.current = [];

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        } 
      });
      streamRef.current = stream;

      // Create MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') 
        ? 'audio/webm' 
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : 'audio/ogg';

      console.log('[Voice Debug] Using MIME type:', mimeType);

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          console.log('[Voice Debug] Audio chunk received:', event.data.size, 'bytes');
        }
      };

      mediaRecorder.onstop = async () => {
        console.log('[Voice Debug] Recording stopped, processing...');
        setIsListening(false);
        setIsProcessing(true);

        try {
          // Combine all chunks into one blob
          const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
          console.log('[Voice Debug] Total audio size:', audioBlob.size, 'bytes');

          // Convert blob to ArrayBuffer
          const arrayBuffer = await audioBlob.arrayBuffer();

          // Send to main process for transcription
          const electronAPI = (window as { electronAPI?: { transcribeAudio: (data: { buffer: ArrayBuffer; mimeType: string }) => Promise<{ success: boolean; transcript?: string; error?: string }> } }).electronAPI;
          
          if (!electronAPI?.transcribeAudio) {
            throw new Error('Transcription API not available');
          }

          console.log('[Voice Debug] Sending audio to main process for transcription...');
          const result = await electronAPI.transcribeAudio({
            buffer: arrayBuffer,
            mimeType,
          });

          if (result.success && result.transcript) {
            console.log('[Voice Debug] Transcription received:', result.transcript);
            optionsRef.current.onTranscript(result.transcript, true);
          } else {
            throw new Error(result.error || 'Transcription failed');
          }
        } catch (err) {
          console.error('[Voice Debug] Transcription error:', err);
          const errorMessage = err instanceof Error ? err.message : 'Failed to transcribe audio';
          setError(errorMessage);
          optionsRef.current.onError?.(errorMessage);
        } finally {
          setIsProcessing(false);
          optionsRef.current.onStop?.();
          
          // Stop all tracks
          streamRef.current?.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error('[Voice Debug] MediaRecorder error:', event);
        setError('Recording error occurred');
        setIsListening(false);
        optionsRef.current.onError?.('Recording error');
      };

      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms
      setIsListening(true);
      console.log('[Voice Debug] Recording started');

    } catch (err) {
      console.error('[Voice Debug] Error starting recording:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to start recording';
      
      if (errorMessage.includes('Permission denied') || errorMessage.includes('NotAllowedError')) {
        setError('Microphone permission denied. Please allow microphone access.');
      } else {
        setError(errorMessage);
      }
      
      optionsRef.current.onError?.(errorMessage);
    }
  }, [isSupported]);

  // Stop recording
  const stopListening = useCallback(() => {
    console.log('[Voice Debug] Stopping recording...');
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    
    // Stop all tracks to release microphone
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  return {
    isListening,
    isSupported,
    isProcessing,
    error,
    permissionState,
    startListening,
    stopListening,
  };
}

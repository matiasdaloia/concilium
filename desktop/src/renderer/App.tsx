/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { useState, useCallback } from 'react';
import HomeScreen from './screens/HomeScreen';
import RunningScreen from './screens/RunningScreen';
import ResultsScreen from './screens/ResultsScreen';
import AnalyticsScreen from './screens/AnalyticsScreen';
import type { RunRecord } from './types';

type Screen = 'home' | 'running' | 'results' | 'analytics';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [currentInitialAgents, setCurrentInitialAgents] = useState<Array<{ key: string; name: string }>>([]);
  const [lastResult, setLastResult] = useState<RunRecord | null>(null);

  const handleStartRun = useCallback((runId: string, initialAgents: Array<{ key: string; name: string }>) => {
    setCurrentRunId(runId);
    setCurrentInitialAgents(initialAgents);
    setScreen('running');
  }, []);

  const handleRunComplete = useCallback((record: RunRecord) => {
    setLastResult(record);
    setScreen('results');
  }, []);

  const handleNewRun = useCallback(() => {
    setCurrentRunId(null);
    setLastResult(null);
    setScreen('home');
  }, []);

  const handleOpenAnalytics = useCallback(() => {
    setScreen('analytics');
  }, []);

  switch (screen) {
    case 'home':
      return <HomeScreen onStartRun={handleStartRun} onOpenAnalytics={handleOpenAnalytics} />;
    case 'running':
      return (
        <RunningScreen
          runId={currentRunId!}
          initialAgents={currentInitialAgents}
          onComplete={handleRunComplete}
          onCancel={handleNewRun}
        />
      );
    case 'results':
      return (
        <ResultsScreen
          record={lastResult!}
          onNewRun={handleNewRun}
        />
      );
    case 'analytics':
      return <AnalyticsScreen onBack={handleNewRun} />;
  }
}

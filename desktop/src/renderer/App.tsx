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

type InitialAgents = Array<{ key: string; name: string }>;

type View =
  | { screen: 'home' }
  | { screen: 'running'; runId: string; initialAgents: InitialAgents }
  | { screen: 'results'; record: RunRecord }
  | { screen: 'analytics' };

export default function App() {
  const [view, setView] = useState<View>({ screen: 'home' });

  const handleStartRun = useCallback((runId: string, initialAgents: InitialAgents) => {
    setView({ screen: 'running', runId, initialAgents });
  }, []);

  const handleRunComplete = useCallback((record: RunRecord) => {
    setView({ screen: 'results', record });
  }, []);

  const handleNewRun = useCallback(() => {
    setView({ screen: 'home' });
  }, []);

  const handleOpenAnalytics = useCallback(() => {
    setView({ screen: 'analytics' });
  }, []);

  switch (view.screen) {
    case 'home':
      return <HomeScreen onStartRun={handleStartRun} onOpenAnalytics={handleOpenAnalytics} />;
    case 'running':
      return (
        <RunningScreen
          runId={view.runId}
          initialAgents={view.initialAgents}
          onComplete={handleRunComplete}
          onCancel={handleNewRun}
        />
      );
    case 'results':
      return (
        <ResultsScreen
          record={view.record}
          onNewRun={handleNewRun}
        />
      );
    case 'analytics':
      return <AnalyticsScreen onBack={handleNewRun} />;
  }
}

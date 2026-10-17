/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { useState, useCallback, useEffect } from 'react';
import { api } from './api';
import HomeScreen from './screens/HomeScreen';
import RunningScreen from './screens/RunningScreen';
import ResultsScreen from './screens/ResultsScreen';
import AnalyticsScreen from './screens/AnalyticsScreen';
import RunViewerScreen, { RunOpenError } from './screens/RunViewerScreen';
import type { RunRecord } from './types';
import type { RunView } from '../shared/run-view';

type InitialAgents = Array<{ key: string; name: string }>;

type View =
  | { screen: 'home' }
  | { screen: 'running'; runId: string; initialAgents: InitialAgents }
  | { screen: 'results'; record: RunRecord }
  | { screen: 'analytics' }
  | { screen: 'code-run'; run: RunView }
  | { screen: 'code-run-error'; message: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function App() {
  const [view, setView] = useState<View>({ screen: 'home' });

  // A run directory given with --open-run is shown at start.
  useEffect(() => {
    api.initialRunDir().then(
      (run) => { if (run) setView({ screen: 'code-run', run }); },
      (err: unknown) => setView({ screen: 'code-run-error', message: errorMessage(err) }),
    );
  }, []);

  const handleOpenRun = useCallback(() => {
    api.openRunDir().then(
      (run) => { if (run) setView({ screen: 'code-run', run }); },
      (err: unknown) => setView({ screen: 'code-run-error', message: errorMessage(err) }),
    );
  }, []);

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
      return <HomeScreen onStartRun={handleStartRun} onOpenAnalytics={handleOpenAnalytics} onOpenRun={handleOpenRun} />;
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
    case 'code-run':
      return <RunViewerScreen run={view.run} onBack={handleNewRun} />;
    case 'code-run-error':
      return <RunOpenError message={view.message} onBack={handleNewRun} />;
  }
}

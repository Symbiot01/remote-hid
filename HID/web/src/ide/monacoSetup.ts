import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// Package exports only rewrite ".js" paths, so the worker and stylesheet are imported by file.
import '../../node_modules/monaco-editor/min/vs/editor/editor.main.css';
import editorWorker from '../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker';

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

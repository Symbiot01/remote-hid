export type EditorTab = {
  id: string;
  name: string;
  value: string;
  dirty: boolean;
};

export type TestStatus = 'idle' | 'pass' | 'fail';

export type TestCase = {
  id: string;
  input: string;
  expected: string;
  actual: string;
  status: TestStatus;
};

export type AgentMode = 'ask' | 'agent';

export type AgentMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

export const INITIAL_MAIN = `#include <iostream>

int main() {
  return 0;
}
`;

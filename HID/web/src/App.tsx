import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LoginView } from './views/LoginView';
import { ConsoleView } from './views/ConsoleView';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LoginView />} />
        <Route path="/app" element={<ConsoleView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

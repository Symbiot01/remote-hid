import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { OpeningPage } from './pages/OpeningPage.tsx';
import { SignedInPage } from './pages/SignedInPage.tsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<OpeningPage />} />
        <Route path="/app" element={<SignedInPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

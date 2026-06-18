import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Layout } from './Layout.tsx';
import { AdminPanel } from './pages/AdminPanel.tsx';
import { BuyerPoListPage } from './pages/BuyerPoListPage.tsx';
import { BuyerPortal } from './pages/BuyerPortal.tsx';
import { CreatePoChangePage } from './pages/CreatePoChangePage.tsx';
import { CreatePoPage } from './pages/CreatePoPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { PoChangeDetailPage } from './pages/PoChangeDetailPage.tsx';
import { PoDetailPage } from './pages/PoDetailPage.tsx';
import { RegisterPage } from './pages/RegisterPage.tsx';
import { SupplierIncomingPosPage } from './pages/SupplierIncomingPosPage.tsx';
import { SupplierPortal } from './pages/SupplierPortal.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route path="/buyer" element={<BuyerPortal />} />
          <Route path="/buyer/po" element={<BuyerPoListPage />} />
          <Route path="/buyer/po/new" element={<CreatePoPage />} />
          <Route path="/buyer/po/:id" element={<PoDetailPage />} />
          <Route path="/buyer/po/:id/change" element={<CreatePoChangePage />} />
          <Route path="/buyer/po-change/:id" element={<PoChangeDetailPage />} />

          <Route path="/supplier" element={<SupplierPortal />} />
          <Route path="/supplier/po" element={<SupplierIncomingPosPage />} />
          <Route path="/supplier/po/:id" element={<PoDetailPage />} />
          <Route path="/supplier/po-change/:id" element={<PoChangeDetailPage />} />

          <Route path="/admin" element={<AdminPanel />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);

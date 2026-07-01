import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Layout } from './Layout.tsx';
import { AcknowledgePoPage } from './pages/AcknowledgePoPage.tsx';
import { AdminPanel } from './pages/AdminPanel.tsx';
import { BuyerDashboardPage } from './pages/BuyerDashboardPage.tsx';
import { BuyerPoListPage } from './pages/BuyerPoListPage.tsx';
import { BuyerPortal } from './pages/BuyerPortal.tsx';
import { CounterpartiesPage } from './pages/CounterpartiesPage.tsx';
import { CreatePoChangePage } from './pages/CreatePoChangePage.tsx';
import { CreatePoPage } from './pages/CreatePoPage.tsx';
import { InboxOutboxPage } from './pages/InboxOutboxPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { OrderConfirmationDetailPage } from './pages/OrderConfirmationDetailPage.tsx';
import { PoChangeDetailPage } from './pages/PoChangeDetailPage.tsx';
import { PoDetailPage } from './pages/PoDetailPage.tsx';
import { RegisterPage } from './pages/RegisterPage.tsx';
import { ScorecardsPage } from './pages/ScorecardsPage.tsx';
import { SupplierDashboardPage } from './pages/SupplierDashboardPage.tsx';
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
          <Route path="/buyer/dashboard" element={<BuyerDashboardPage />} />
          <Route path="/buyer/inbox" element={<InboxOutboxPage />} />
          <Route path="/buyer/counterparties" element={<CounterpartiesPage />} />
          <Route path="/buyer/scorecards" element={<ScorecardsPage />} />
          <Route path="/buyer/po" element={<BuyerPoListPage />} />
          <Route path="/buyer/po/new" element={<CreatePoPage />} />
          <Route path="/buyer/po/:id" element={<PoDetailPage />} />
          <Route path="/buyer/po/:id/change" element={<CreatePoChangePage />} />
          <Route path="/buyer/po-change/:id" element={<PoChangeDetailPage />} />
          <Route path="/buyer/order-confirmation/:id" element={<OrderConfirmationDetailPage />} />

          <Route path="/supplier" element={<SupplierPortal />} />
          <Route path="/supplier/dashboard" element={<SupplierDashboardPage />} />
          <Route path="/supplier/inbox" element={<InboxOutboxPage />} />
          <Route path="/supplier/counterparties" element={<CounterpartiesPage />} />
          <Route path="/supplier/po" element={<SupplierIncomingPosPage />} />
          <Route path="/supplier/po/:id" element={<PoDetailPage />} />
          <Route path="/supplier/po/:id/acknowledge" element={<AcknowledgePoPage />} />
          <Route path="/supplier/po-change/:id" element={<PoChangeDetailPage />} />
          <Route
            path="/supplier/order-confirmation/:id"
            element={<OrderConfirmationDetailPage />}
          />

          <Route path="/admin" element={<AdminPanel />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);

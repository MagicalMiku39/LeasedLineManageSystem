import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { apiBase, jsonBody, requestJson } from './api.js';
import AppHeader from './components/AppHeader.jsx';
import { AuthStatusView, LoginView, SetupView } from './components/AuthViews.jsx';
import { NoticeBar } from './components/Feedback.jsx';
import GroupRevenue from './GroupRevenue.jsx';
import ImportRecords from './ImportRecords.jsx';
import BatchModal from './ledger/BatchModal.jsx';
import { defaultManagers } from './ledger/config.js';
import DetailDrawer from './ledger/DetailDrawer.jsx';
import LedgerView from './ledger/LedgerView.jsx';
import { ledgerPeriodExportQuery } from './ledger/query.js';
import { useColumnSettings } from './ledger/useColumnSettings.js';
import { useLedger, useLedgerOptions, useLedgerStats } from './ledger/useLedgerData.js';
import ManagerDashboard, { useManagerPerformance } from './ManagerDashboard.jsx';
import Operations from './Operations.jsx';
import { beijingMonth } from './utils.js';

const refreshTitles = {
  ledger: '重新读取台账、统计和筛选项',
  managers: '重新统计客户经理净增',
  revenue: '重新读取收入数据',
  operations: '重新读取预警',
  imports: '重新读取导入记录'
};

function App() {
  const [auth, setAuth] = useState({ loading: true, configured: true, user: null, error: '' });
  const signedIn = Boolean(auth.user);
  const [activeView, setActiveView] = useState('ledger');
  const [kpiMode, setKpiMode] = useState(true);
  const [month, setMonth] = useState(() => beijingMonth());
  const [notice, setNotice] = useState(null);
  // An expired session sends the user back to the login form instead of showing stale data.
  const handleUnauthorized = useCallback(() => setAuth({ loading: false, configured: true, user: null, error: '' }), []);

  const ledger = useLedger({ enabled: signedIn, kpiMode, month, onUnauthorized: handleUnauthorized });
  const statsResource = useLedgerStats({ enabled: signedIn, month, kpiMode, onUnauthorized: handleUnauthorized });
  const { options, reload: reloadOptions } = useLedgerOptions({ enabled: signedIn, onUnauthorized: handleUnauthorized });
  const columns = useColumnSettings();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [managerSelection, setManagerSelection] = useState(() => [...defaultManagers]);
  const [managerSort, setManagerSort] = useState('yearScaleNet');
  const managerPerformance = useManagerPerformance({
    enabled: signedIn && activeView === 'managers',
    month,
    sort: managerSort,
    selection: managerSelection,
    kpiMode
  });

  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [showBatch, setShowBatch] = useState(false);
  const revenueActions = useRef(null);
  const operationsActions = useRef(null);
  const [revenueRevision, setRevenueRevision] = useState(0);
  const [operationsRevision, setOperationsRevision] = useState(0);
  const [importsRevision, setImportsRevision] = useState(0);
  const [revenueExportReady, setRevenueExportReady] = useState(false);

  async function loadAuthStatus() {
    setAuth((current) => ({ ...current, loading: true, error: '' }));
    try {
      const data = await requestJson('/auth/status');
      setAuth({ loading: false, configured: data.configured, user: data.user || null, error: '' });
    } catch (error) {
      setAuth((current) => ({ ...current, loading: false, error: error.message }));
    }
  }

  useEffect(() => {
    loadAuthStatus();
  }, []);

  async function logout() {
    try {
      await requestJson('/auth/logout', jsonBody('POST', {}));
      setNotice(null);
      setSelected(null);
      setAuth({ loading: false, configured: true, user: null, error: '' });
    } catch (error) {
      setNotice({ tone: 'error', text: `退出失败：${error.message}` });
    }
  }

  function selectView(view) {
    // Every visit to the manager page starts from the default 18 managers.
    if (view === 'managers' && activeView !== 'managers') setManagerSelection([...defaultManagers]);
    setActiveView(view);
  }

  function applyStat(statFilter) {
    setActiveView('ledger');
    ledger.applyStat(statFilter);
  }

  function changeKpiMode(checked) {
    setKpiMode(checked);
    ledger.resetForScopeChange();
  }

  function reloadLedgerPage() {
    ledger.reload();
    statsResource.reload();
  }

  async function uploadLedgerExcel(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    setUploading(true);
    setNotice(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const data = await requestJson('/import', { method: 'POST', body: formData });
      setNotice({
        tone: data.failedRows > 0 ? 'error' : 'success',
        text: `${file.name} 导入完成：新增 ${data.successRows} 条，更新 ${data.updatedRows} 条，失败 ${data.failedRows} 条${data.failedRows > 0 ? '，失败原因见“导入记录”' : ''}`
      });
      setOperationsRevision((value) => value + 1);
      setImportsRevision((value) => value + 1);
      reloadLedgerPage();
      reloadOptions();
    } catch (error) {
      setNotice({ tone: 'error', text: `${file.name} 导入失败：${error.message}` });
    } finally {
      setUploading(false);
      input.value = '';
    }
  }

  async function openDetail(id) {
    try {
      setSelected(await requestJson(`/ledger/${id}`));
    } catch (error) {
      setNotice({ tone: 'error', text: `专线详情读取失败：${error.message}` });
    }
  }

  function exportLedger() {
    window.location.href = `${apiBase}/ledger/export?${ledger.exportQuery}`;
  }

  // The lines counted in the year / quarter totals; only the KPI scope applies, like those totals.
  function exportPeriodChanges(period) {
    window.location.href = `${apiBase}/ledger/export-period?${ledgerPeriodExportQuery(period, kpiMode)}`;
  }

  const periodYear = statsResource.stats?.currentYear;
  const periodQuarter = statsResource.stats?.currentQuarter;
  const ledgerExportMenu = [
    { key: 'ledger', label: '导出当前台账', hint: '跟随当前筛选和排序', run: exportLedger },
    {
      key: 'year',
      label: periodYear ? `${periodYear} 年新增与销户` : '本年度新增与销户',
      hint: '新增、销户各一张表',
      run: () => exportPeriodChanges('year')
    },
    {
      key: 'quarter',
      label: periodQuarter ? `第 ${periodQuarter} 季度新增与销户` : '本季度新增与销户',
      hint: '新增、销户各一张表',
      run: () => exportPeriodChanges('quarter')
    }
  ];

  // What the shared top-bar actions do on each page.
  const importAction = activeView === 'revenue'
    ? { kind: 'dialog', title: '导入收入报表', open: () => revenueActions.current?.openImport() }
    : { kind: 'file', title: '导入专线台账 Excel', busy: uploading, onFile: uploadLedgerExcel };

  const exportActions = {
    operations: { title: '导出当前预警', run: () => operationsActions.current?.exportData() },
    revenue: { title: '导出当前收入视图', run: () => revenueActions.current?.exportData(), disabled: !revenueExportReady }
  };
  const exportAction = exportActions[activeView] || { title: '导出台账', run: exportLedger, menu: ledgerExportMenu };

  function refreshCurrentView() {
    if (activeView === 'operations') {
      operationsActions.current?.refresh();
      return;
    }
    if (activeView === 'revenue') {
      revenueActions.current?.refresh();
      return;
    }
    reloadLedgerPage();
    reloadOptions();
    if (activeView === 'managers') managerPerformance.reload();
    if (activeView === 'imports') setImportsRevision((value) => value + 1);
  }

  if (auth.loading || auth.error) {
    return <AuthStatusView error={auth.error} onRetry={loadAuthStatus} />;
  }

  if (!auth.configured) {
    return <SetupView onReady={loadAuthStatus} />;
  }

  if (!auth.user) {
    return <LoginView onLogin={(user) => setAuth({ loading: false, configured: true, user, error: '' })} />;
  }

  function renderView() {
    switch (activeView) {
      case 'operations':
        return <Operations ref={operationsActions} kpiMode={kpiMode} refreshToken={operationsRevision} onOpenLine={openDetail} />;
      case 'revenue':
        return (
          <GroupRevenue
            ref={revenueActions}
            onExportReady={setRevenueExportReady}
            kpiMode={kpiMode}
            defaultManagers={defaultManagers}
            refreshToken={revenueRevision}
            onOpenLine={(row) => openDetail(row.id)}
          />
        );
      case 'imports':
        return <ImportRecords refreshToken={importsRevision} />;
      case 'managers':
        return (
          <ManagerDashboard
            month={month}
            setMonth={setMonth}
            options={options}
            selectedManagers={managerSelection}
            setSelectedManagers={setManagerSelection}
            sort={managerSort}
            setSort={setManagerSort}
            data={managerPerformance.data}
            loading={managerPerformance.loading}
            error={managerPerformance.error}
            reload={managerPerformance.reload}
          />
        );
      default:
        return (
          <LedgerView
            stats={statsResource.stats}
            statsError={statsResource.error}
            onRetryStats={statsResource.reload}
            month={month}
            onMonthChange={setMonth}
            filters={ledger.filters}
            options={options}
            onFilterChange={ledger.updateFilter}
            onClearFilters={ledger.clearFilters}
            onApplyStat={applyStat}
            showAdvanced={showAdvanced}
            onToggleAdvanced={() => setShowAdvanced(!showAdvanced)}
            ledger={ledger}
            columns={columns}
            onBatchEdit={() => setShowBatch(true)}
            onOpenRow={openDetail}
          />
        );
    }
  }

  return (
    <div className="app">
      <AppHeader
        activeView={activeView}
        onSelectView={selectView}
        kpiMode={kpiMode}
        onKpiModeChange={changeKpiMode}
        importAction={importAction}
        exportAction={exportAction}
        onRefresh={refreshCurrentView}
        refreshing={activeView === 'ledger' && ledger.loading}
        refreshTitle={refreshTitles[activeView]}
        onLogout={logout}
      />
      <NoticeBar notice={notice} onClose={() => setNotice(null)} />

      {renderView()}

      <DetailDrawer
        record={selected}
        onClose={() => setSelected(null)}
        onSaved={(record) => {
          setSelected(record);
          setRevenueRevision((value) => value + 1);
          reloadLedgerPage();
        }}
      />

      {showBatch && (
        <BatchModal
          ids={ledger.selectedIds}
          onClose={() => setShowBatch(false)}
          onSaved={(result) => {
            setShowBatch(false);
            const count = result?.updated ?? ledger.selectedIds.length;
            setNotice({ tone: 'success', text: `批量编辑已保存（${count} 条记录）` });
            reloadLedgerPage();
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);

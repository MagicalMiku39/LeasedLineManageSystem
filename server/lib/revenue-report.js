import { addCents, comparison, fail, money, netCents, previousMonth, productTaxRate, safeCents, share, toCents, validMonth } from './revenue-money.js';

const status = (line) => line.product_status_name ?? line.ledger_status ?? '';
const sum = (rows, key) => rows.reduce((total, row) => addCents(total, row[key]), 0);
const nullableSum = (rows, key) => rows.length ? sum(rows, key) : null;
const viewService = (row) => {
  const data = JSON.parse(row.data_json);
  return { ...data, id: row.id, version: row.version, grossAmount: money(data.grossCents), revenue: money(data.netCents),
    taxRate: 0.06, createdBy: row.created_by, updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at };
};

export function estimateLine(line, month) {
  const billable = status(line) === '正常在用'
    || (['停机执行中', '停机'].includes(status(line)) && String(line.status_time || '').slice(0, 7) === month);
  const rate = productTaxRate(line.product_name);
  const monthly = toCents(Number(line.actual_monthly_fee) > 0 ? line.actual_monthly_fee : line.package_fee, '月资费', true);
  const oneTime = String(line.start_time || '').slice(0, 7) === month ? toCents(line.one_time_fee, '单次费用', true) : 0;
  const gross = billable ? addCents(monthly, oneTime) : 0;
  return { gross, net: rate === null ? null : netCents(gross, rate), rate, oneTime: billable ? oneTime : 0 };
}

export function createRevenueQueries({ db, leasedLineSource }) {
  const activeMonths = () => db.prepare('SELECT month, batch_id FROM revenue_batch_month WHERE active = 1 ORDER BY month DESC').all();
  let aggregateCache = { key: null, rows: [] };
  let managerCache = { key: null, rows: [] };
  function meta() {
    const months = activeMonths();
    const key = JSON.stringify(months);
    if (managerCache.key !== key) managerCache = { key, rows: db.prepare(`SELECT DISTINCT json_extract(r.data_json, '$.managerId') AS id,
        json_extract(r.data_json, '$.managerName') AS name FROM revenue_source_row r
        JOIN revenue_batch_month b ON b.batch_id = r.batch_id AND b.month = r.month AND b.active = 1
        WHERE r.group_code <> '' ORDER BY name, id`).all() };
    return {
      months: months.map((row) => row.month),
      managers: managerCache.rows,
      batches: db.prepare(`SELECT b.id, b.file_name AS fileName, b.status, b.created_by AS createdBy,
        b.created_at AS createdAt, b.committed_at AS committedAt,
        (SELECT group_concat(month, ', ') FROM revenue_batch_month WHERE batch_id = b.id) AS months,
        (SELECT group_concat(month, ', ') FROM revenue_batch_month WHERE batch_id = b.id AND active = 1) AS activeMonths,
        (SELECT COUNT(*) FROM revenue_source_row WHERE batch_id = b.id) AS rowCount
        FROM revenue_batch b ORDER BY b.created_at DESC LIMIT 100`).all()
    };
  }

  function context(query) {
    const months = activeMonths();
    const month = query.month ? validMonth(query.month) : months[0]?.month ?? null;
    const batches = new Map(months.map((item) => [item.month, item.batch_id]));
    const services = db.prepare('SELECT * FROM revenue_service WHERE deleted = 0').all().map(viewService);
    // Committed source rows are immutable; active batch identities invalidate this cache.
    const cacheKey = JSON.stringify(months);
    if (aggregateCache.key !== cacheKey) aggregateCache = { key: cacheKey, rows: db.prepare(`SELECT r.month, r.group_code AS groupCode,
      json_extract(r.data_json, '$.groupName') AS groupName,
      json_extract(r.data_json, '$.managerId') AS managerId,
      json_extract(r.data_json, '$.managerName') AS managerName,
      SUM(json_extract(r.data_json, '$.revenue')) AS reportCents,
      SUM(CASE WHEN json_extract(r.data_json, '$.category') = '专线' THEN json_extract(r.data_json, '$.revenue') ELSE 0 END) AS lineCents
      FROM revenue_source_row r JOIN revenue_batch_month b ON b.batch_id = r.batch_id AND b.month = r.month AND b.active = 1
      WHERE r.group_code <> '' GROUP BY r.month, r.group_code`).all() };
    const aggregates = aggregateCache.rows.map((row) => ({ ...row,
        reportCents: safeCents(row.reportCents), lineCents: safeCents(row.lineCents), supplementCents: 0, needsReviewCount: 0 }));
    const indexed = new Map(aggregates.map((row) => [JSON.stringify([row.month, row.groupCode]), row]));
    for (const service of services) {
      const group = indexed.get(JSON.stringify([service.month, service.groupCode]));
      if (!group) continue;
      if (service.needsReview) group.needsReviewCount++;
      if (service.coverage === 'excluded' && service.confirmed && !service.needsReview && service.confirmedBatchId === batches.get(service.month)) {
        group.supplementCents = addCents(group.supplementCents, service.netCents);
      }
    }
    for (const group of aggregates) group.totalCents = addCents(group.reportCents, group.supplementCents);
    const lineCounts = new Map(db.prepare(`SELECT group_code, COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(product_status_name, ledger_status, '') = '正常在用' THEN 1 ELSE 0 END) AS active
      FROM ${leasedLineSource(query)} GROUP BY group_code`).all().map((row) => [row.group_code, row]));
    const matchedGroups = new Set(db.prepare("SELECT DISTINCT group_code FROM leased_line WHERE group_code <> ''").all().map((row) => row.group_code));
    return { months, month, batches, services, aggregates, indexed, lineCounts, matchedGroups };
  }

  function groupView(group, ctx, month) {
    const before = ctx.indexed.get(JSON.stringify([previousMonth(month), group.groupCode]));
    return { groupCode: group.groupCode, groupName: group.groupName, managerId: group.managerId, managerName: group.managerName,
      reportRevenue: money(group.reportCents), totalRevenue: money(group.totalCents), lineRevenue: money(group.lineCents),
      supplementRevenue: money(group.supplementCents), lineShare: share(group.lineCents, group.totalCents),
      currentLineCount: ctx.lineCounts.get(group.groupCode)?.active ?? 0, currentTotalLineCount: ctx.lineCounts.get(group.groupCode)?.total ?? 0,
      matched: ctx.matchedGroups.has(group.groupCode), needsReviewCount: group.needsReviewCount, hasReport: true,
      managerChanged: Boolean(before && before.managerId !== group.managerId), previousManagerName: before?.managerName ?? null,
      ...comparison(group.totalCents, before?.totalCents ?? null) };
  }

  function summary(query = {}) {
    const ctx = context(query);
    const { month } = ctx;
    if (!month) return { month: null, previousMonth: null, summary: { totalRevenue: null, lineRevenue: null, supplementRevenue: 0,
      groupCount: 0, ungroupedRevenue: 0, previousRevenue: null, change: null, changeRate: null }, managers: [], groups: [], trend: [] };
    const selected = String(query.managers ?? '').split('|').filter(Boolean);
    const keyword = String(query.keyword ?? '').trim().toLocaleLowerCase();
    const inScope = (row) => (!selected.length || selected.includes(row.managerId))
      && (!keyword || `${row.groupCode} ${row.groupName}`.toLocaleLowerCase().includes(keyword));
    const current = ctx.aggregates.filter((row) => row.month === month && inScope(row));
    const priorMonth = previousMonth(month);
    const prior = ctx.aggregates.filter((row) => row.month === priorMonth && inScope(row));
    const total = ctx.batches.has(month) ? sum(current, 'totalCents') : null;
    const previous = ctx.batches.has(priorMonth) && prior.length ? sum(prior, 'totalCents') : null;
    const managerIds = [...new Set(current.map((row) => row.managerId))];
    const managers = managerIds.map((id) => {
      const rows = current.filter((row) => row.managerId === id);
      const older = prior.filter((row) => row.managerId === id);
      const value = sum(rows, 'totalCents'), line = sum(rows, 'lineCents');
      return { id, name: rows[0].managerName || '未填写客户经理', groupCount: rows.length,
        totalRevenue: money(value), lineRevenue: money(line), supplementRevenue: money(sum(rows, 'supplementCents')),
        lineShare: share(line, value), ...comparison(value, nullableSum(older, 'totalCents')) };
    });
    const ungrouped = db.prepare(`SELECT COALESCE(SUM(json_extract(r.data_json, '$.revenue')),0) AS total FROM revenue_source_row r
      JOIN revenue_batch_month b ON b.batch_id = r.batch_id AND b.month = r.month AND b.active = 1
      WHERE r.month = ? AND r.group_code = ''`).get(month).total;
    return { month, previousMonth: priorMonth,
      summary: { totalRevenue: money(total), reportRevenue: ctx.batches.has(month) ? money(sum(current, 'reportCents')) : null,
        lineRevenue: ctx.batches.has(month) ? money(sum(current, 'lineCents')) : null,
        supplementRevenue: money(sum(current, 'supplementCents')), groupCount: current.length,
        ungroupedRevenue: money(ungrouped), ungroupedScope: '全报表', ...comparison(total, previous) },
      managers, groups: current.map((row) => groupView(row, ctx, month)),
      trend: ctx.months.map(({ month: period }) => {
        const scoped = ctx.aggregates.filter((row) => row.month === period && inScope(row));
        return { month: period, totalRevenue: money(nullableSum(scoped, 'totalCents')), lineRevenue: money(nullableSum(scoped, 'lineCents')) };
      }).reverse() };
  }

  function detail(code, query = {}) {
    const ctx = context(query);
    const { month } = ctx;
    if (!month) fail('尚无收入报表，请先导入');
    const history = ctx.aggregates.filter((row) => row.groupCode === code).sort((a, b) => a.month.localeCompare(b.month));
    if (!history.length) fail('集团不存在于有效收入报表');
    const current = ctx.indexed.get(JSON.stringify([month, code]));
    const group = current ? groupView(current, ctx, month) : { groupCode: code, groupName: history.at(-1).groupName,
      managerName: null, managerId: null, hasReport: false, totalRevenue: null, lineRevenue: null, reportRevenue: null,
      supplementRevenue: 0, lineShare: null, previousRevenue: null, change: null, changeRate: null,
      currentLineCount: ctx.lineCounts.get(code)?.active ?? 0, matched: ctx.matchedGroups.has(code) };
    const getRows = (period) => db.prepare(`SELECT r.id, r.data_json FROM revenue_source_row r
      JOIN revenue_batch_month b ON b.batch_id = r.batch_id AND b.month = r.month AND b.active = 1
      WHERE r.month = ? AND r.group_code = ? ORDER BY r.row_number`).all(period, code)
      .map((row) => ({ ...JSON.parse(row.data_json), id: row.id }));
    const rows = getRows(month), oldRows = getRows(previousMonth(month));
    const productsByKey = (items) => {
      const result = new Map();
      for (const row of items) {
        const key = JSON.stringify([row.productId, row.productName, row.category]);
        const entry = result.get(key) || { productId: row.productId, productName: row.productName, category: row.category, cents: 0 };
        entry.cents = addCents(entry.cents, row.revenue);
        result.set(key, entry);
      }
      return result;
    };
    const thisProducts = productsByKey(rows), oldProducts = productsByKey(oldRows);
    const products = [...new Set([...thisProducts.keys(), ...oldProducts.keys()])].map((key) => {
      const item = thisProducts.get(key), before = oldProducts.get(key);
      return { ...(item || before), revenue: money(item?.cents ?? null), ...comparison(item?.cents ?? null, before?.cents ?? null) };
    });
    const lines = db.prepare(`SELECT * FROM ${leasedLineSource(query)} WHERE group_code = ? ORDER BY group_product_code, id`).all(code);
    const estimates = lines.map((line) => estimateLine(line, month));
    const gross = sum(estimates, 'gross');
    const net = estimates.some((item) => item.net === null && item.gross !== 0) ? null : sum(estimates.map((item) => ({ net: item.net ?? 0 })), 'net');
    const services = ctx.services.filter((service) => service.groupCode === code && (service.month === month
      || (service.frequency === 'monthly' && service.month < month && (!service.endMonth || service.endMonth >= month))))
      .map((service) => ({ ...service, projected: service.month !== month }));
    const confirmedServices = services.filter((service) => !service.projected && service.confirmed && !service.needsReview
      && service.coverage !== 'pending' && service.confirmedBatchId === ctx.batches.get(month));
    const serviceNet = sum(confirmedServices, 'netCents');
    const includedServices = confirmedServices.filter((service) => service.coverage === 'included');
    const serviceScopeUnknown = includedServices.some((service) => !rows.some((row) => row.id === service.sourceRowId));
    const outsideLineServices = includedServices.filter((service) => rows.some((row) => row.id === service.sourceRowId && row.category !== '专线'));
    const includedOutsideLineNet = sum(outsideLineServices, 'netCents');
    const referenceDifference = current && net !== null && !serviceScopeUnknown
      ? addCents(current.lineCents, current.supplementCents, includedOutsideLineNet, -net, -serviceNet) : null;
    const tolerance = db.prepare('SELECT tolerance_cents FROM revenue_settings WHERE id = 1').get().tolerance_cents;
    const messages = ['缺少所选月份的历史台账快照，以下金额为当前台账推算。',
      '报表专线与台账产品映射尚未核验，参考差额不代表准确对账结果。'];
    if (String(query.kpiMode ?? '1') !== '0') messages.push('台账预计值仅包含 KPI 十类产品，报表专线收入保留完整分类，范围可能不同。');
    if (!ctx.matchedGroups.has(code)) messages.push('该集团尚未关联到当前专线台账。');
    if (!current) messages.push('该集团在所选月份无报表记录。');
    if (estimates.some((item) => item.oneTime !== 0)) messages.push('单次费用暂按所属产品税率除税；如存在独立税种，需要另行核验。');
    if (net === null) messages.push('部分台账产品名称为空，预计税后金额无法完整计算。');
    const adjustment = rows.reduce((value, row) => addCents(value, row.adjustment, -row.adjustmentTax), 0);
    if (adjustment !== 0) messages.push(`报表包含税后调账 ${money(adjustment)}，需纳入差额核验。`);
    const taxMismatchCount = rows.filter((row) => {
      const rate = productTaxRate(row.productName);
      return rate !== null && (Math.abs(addCents(row.gross, -netCents(row.gross, rate), -row.tax)) > tolerance
        || Math.abs(addCents(row.adjustment, -netCents(row.adjustment, rate), -row.adjustmentTax)) > tolerance);
    }).length;
    if (taxMismatchCount) messages.push(`${taxMismatchCount} 行实际税费与配置税率推算有差异，保留报表原值，请核验。`);
    if (services.some((service) => service.needsReview)) messages.push('报表已修订，已有延伸服务需重新核验是否包含。');
    if (serviceScopeUnknown) messages.push('已包含服务尚未关联报表源行，无法确定专线收入是否已覆盖该服务，参考差额暂不计算。');
    if (includedOutsideLineNet !== 0) messages.push(`核对时另计非专线报表分类中的已登记服务 ${money(includedOutsideLineNet)}；集团实际收入不重复增加。`);
    if (referenceDifference > tolerance) messages.push('参考收入高于台账推算；核验产品范围、调账和资费后，可检查是否存在尚未登记的专线延伸服务。');
    if (referenceDifference !== null && referenceDifference < -tolerance) messages.push('参考收入低于台账推算，请核验减免、调账、状态时间或资费变化。');
    return { group, products, lines, services,
      trend: ctx.months.slice().reverse().map(({ month: period }) => {
        const row = ctx.indexed.get(JSON.stringify([period, code]));
        return { month: period, totalRevenue: money(row?.totalCents ?? null), lineRevenue: money(row?.lineCents ?? null), managerName: row?.managerName ?? null };
      }),
      sourceRows: rows.map((row) => ({ ...row, gross: money(row.gross), tax: money(row.tax), adjustment: money(row.adjustment),
        adjustmentTax: money(row.adjustmentTax), revenue: money(row.revenue) })),
      reconciliation: { status: 'insufficient', grossEstimate: money(gross), netEstimate: money(net),
        reportLineRevenue: group.lineRevenue, serviceNet: money(serviceNet), difference: null,
        referenceDifference: money(referenceDifference), tolerance: money(tolerance), messages,
        taxMismatchCount, adjustment: money(adjustment), projectedServiceNet: money(sum(services.filter((service) => service.projected), 'netCents')) },
      audit: db.prepare(`SELECT action, actor, created_at AS createdAt, entity_id AS entityId FROM revenue_audit
        WHERE entity_type = 'service' AND entity_id IN (SELECT id FROM revenue_service WHERE group_code = ?)
        ORDER BY id DESC LIMIT 100`).all(code) };
  }
  return { meta, summary, detail };
}

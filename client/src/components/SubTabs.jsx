import React from 'react';

// The second-level switch under a top menu (运营中心's sections, 台账 / 导入记录).
export default function SubTabs({ label, items, active, onChange }) {
  return (
    <nav className="sub-tabs" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={active === item.key ? 'active' : undefined}
          aria-current={active === item.key ? 'page' : undefined}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

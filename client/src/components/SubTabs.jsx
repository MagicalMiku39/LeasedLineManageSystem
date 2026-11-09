import React, { useEffect, useRef } from 'react';

// The second-level switch under a top menu (运营中心's sections, 台账 / 导入记录). On a narrow
// screen the row scrolls, and it keeps the selected one in view.
export default function SubTabs({ label, items, active, onChange }) {
  const nav = useRef(null);

  useEffect(() => {
    const row = nav.current;
    const current = row?.querySelector('[aria-current="page"]');
    if (!row || !current || row.scrollWidth <= row.clientWidth) return;
    const rowBox = row.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    if (box.left < rowBox.left || box.right > rowBox.right) {
      row.scrollLeft += box.left - rowBox.left - (rowBox.width - box.width) / 2;
    }
  }, [active]);

  return (
    <nav ref={nav} className="sub-tabs" aria-label={label}>
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

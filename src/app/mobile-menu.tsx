"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { IconClose, IconMenu } from "./icons";
import LogoutForm from "./logout-form";
import { activeHref, type NavItem } from "./nav-links";

/**
 * The menu of a phone: a button in the top bar that opens a drawer sliding in from the right with every section, the account
 * and the sign-out. A modal <dialog>: Esc or a tap outside closes it, focus stays inside, the page behind cannot be scrolled.
 */
export default function MobileMenu({ items, email }: { items: NavItem[]; email: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const titleId = useId();
  const active = activeHref(pathname, items);

  useEffect(() => { if (open && !dialogRef.current?.open) dialogRef.current?.showModal(); }, [open]);
  // Going to another section closes the drawer (the link itself is a normal navigation), and so does growing into a computer-sized
  // window (wider than the compact bar, see neo.css) (the drawer is not drawn there, so its backdrop must not stay behind).
  useEffect(() => { dialogRef.current?.close(); }, [pathname]);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1001px)");
    const close = () => { if (wide.matches) dialogRef.current?.close(); };
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, []);

  return <>
    <button type="button" className="btn small icon nav-menu-button" aria-haspopup="dialog" aria-expanded={open} aria-label="Mở menu" onClick={() => setOpen(true)}>
      <IconMenu />
    </button>
    <dialog ref={dialogRef} className="nav-drawer" aria-labelledby={titleId} onClose={() => setOpen(false)}
      onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
      {open && <div className="drawer-body">
        <div className="drawer-head">
          <h2 id={titleId}>Menu</h2>
          <button type="button" className="btn small icon" aria-label="Đóng menu" onClick={() => dialogRef.current?.close()}><IconClose /></button>
        </div>
        <ul className="drawer-links">
          {items.map(({ href, label, icon }) => <li key={href}>
            <Link className="nav-link" href={href} aria-current={href === active ? "page" : undefined} onClick={() => dialogRef.current?.close()}>{icon}{label}</Link>
          </li>)}
        </ul>
        <div className="drawer-account">
          {email && <p className="drawer-email" title={email}>{email}</p>}
          <LogoutForm className="btn" />
        </div>
      </div>}
    </dialog>
  </>;
}

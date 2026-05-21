'use client';

import { useState, useRef, useEffect } from 'react';
import { useAccount } from 'wagmi';
import {
  fetchNotificationsByWallet,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  type Notification,
} from '@/lib/store';

export function NotificationBell() {
  const { address, isConnected } = useAccount();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Poll notifications every 3s from backend
  useEffect(() => {
    if (!address) return;
    const load = () => {
      fetchNotificationsByWallet(address).then(notifs => {
        setNotifications(notifs);
        setUnread(notifs.filter(n => !n.read).length);
      });
    };
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [address]);

  if (!isConnected) return null;

  const handleMarkRead = (id: string) => {
    markNotificationRead(id);
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    setUnread(prev => Math.max(0, prev - 1));
  };

  const handleMarkAllRead = () => {
    if (!address) return;
    markAllNotificationsRead(address);
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnread(0);
  };

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const typeIcon = (type: Notification['type']) => {
    switch (type) {
      case 'send': return '$';
      case 'vouch': return 'V';
      case 'system': return 'N';
    }
  };

  return (
    <div className="relative" ref={ref}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(!open)}
        className="relative flex items-center justify-center w-9 h-9 border border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,133,18,0.3)] transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-400">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {/* Unread badge */}
        {unread > 0 && (
          <div className="absolute -top-1 -right-1 w-4 h-4 bg-[#ff8512] flex items-center justify-center">
            <span className="font-mono text-[9px] text-[#050505] font-bold">{unread > 9 ? '9+' : unread}</span>
          </div>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 mt-1 w-80 bg-[#0c0c0c] border border-[rgba(255,255,255,0.06)] animate-fade-in z-50 max-h-[420px] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[rgba(255,255,255,0.06)]">
            <span className="font-mono text-xs text-white tracking-wider uppercase">Notifications</span>
            {unread > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="font-mono text-[10px] text-[#ff8512] hover:text-[#ffa038] transition-colors"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1">
            {notifications.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <div className="text-surface-600 text-sm font-mono mb-1">No notifications</div>
                <p className="text-surface-700 text-[10px]">Activity will appear here</p>
              </div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  onClick={() => handleMarkRead(n.id)}
                  className={`px-4 py-3 border-b border-[rgba(255,255,255,0.03)] cursor-pointer transition-colors hover:bg-[#141414] ${
                    !n.read ? 'bg-[rgba(255,133,18,0.03)]' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-sm mt-0.5 shrink-0">{typeIcon(n.type)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-medium text-white truncate">{n.title}</span>
                        {!n.read && <div className="w-1.5 h-1.5 bg-[#ff8512] shrink-0" />}
                      </div>
                      <p className="text-[11px] text-surface-400 truncate">{n.message}</p>
                      <span className="text-[9px] text-surface-600 font-mono mt-1 block">{timeAgo(n.createdAt)}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

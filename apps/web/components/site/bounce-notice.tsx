"use client"

import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"

/*
 * The 404 as a bounce: the raw delivery status notification a mail server
 * sends when a recipient does not exist, addressed to whoever asked for the
 * missing page and quoting the path they asked for.
 */
export function BounceNotice() {
  const pathname = usePathname()
  const [date, setDate] = useState("")

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the date must be the reader's, which the server cannot know
    setDate(new Date().toUTCString().replace("GMT", "+0000"))
  }, [])

  const rows: [string, string][] = [
    ["From", "Mail Delivery Subsystem <MAILER-DAEMON@i10.tech>"],
    ["To", "you@wherever.you.are"],
    ["Date", date || " "],
    ["Subject", "Undelivered Mail Returned to Sender"],
  ]

  return (
    <div className="bounce-card relative overflow-hidden rounded-[18px] bg-surface-1 font-mono text-[12px] leading-[20px]">
      <div className="flex items-center gap-1.5 border-b border-line px-4 py-3">
        <span className="size-2.5 rounded-full bg-white/10" />
        <span className="size-2.5 rounded-full bg-white/10" />
        <span className="size-2.5 rounded-full bg-white/10" />
        <span className="ml-3 text-[11px] text-fg-4">message/delivery-status</span>
      </div>
      <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 border-b border-line-faint px-5 py-4">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-4">{k}:</dt>
            <dd className="truncate text-fg-2">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="px-5 py-5 text-fg-3">
        <p>This is the mail system at host i10.tech.</p>
        <p className="mt-3">
          I&apos;m sorry to have to inform you that your request could not be delivered
          to one or more recipients.
        </p>
        <p className="mt-4 text-fg-2">
          &lt;<span className="text-brand">{pathname}</span>&gt;: host i10.tech said:
        </p>
        <p className="mt-1 text-bounced">
          550 5.1.1 Recipient address rejected: page unknown in local recipient table
        </p>
        <p className="mt-4 text-fg-4">Reporting-MTA: dns; i10.tech</p>
        <p className="text-fg-4">Action: failed · Status: 5.1.1</p>
      </div>
      <svg
        aria-hidden
        viewBox="0 0 200 200"
        className="bounce-stamp pointer-events-none absolute -right-6 -bottom-8 w-[170px] text-brand"
      >
        <defs>
          <path
            id="stamp-path"
            d="M100 100m-72 0a72 72 0 1 1 144 0a72 72 0 1 1-144 0"
          />
        </defs>
        <circle
          cx="100"
          cy="100"
          r="92"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <circle
          cx="100"
          cy="100"
          r="54"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <text className="fill-current font-mono text-[15px] font-semibold tracking-[0.2em]">
          <textPath href="#stamp-path">RETURN TO SENDER · RETURN TO SENDER · </textPath>
        </text>
        <text
          x="100"
          y="112"
          textAnchor="middle"
          className="fill-current font-mono text-[34px] font-bold"
        >
          404
        </text>
      </svg>
    </div>
  )
}

"use client";

import NextLink from "next/link";
import { forwardRef } from "react";

import { useOrgHref } from "@/lib/org-href";

type LinkProps = React.ComponentProps<typeof NextLink>;

/** `next/link` that opens app paths (`/p/<id>/pages`) in the current organization. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, ...props }, ref) {
  const orgHref = useOrgHref();
  return <NextLink href={typeof href === "string" ? orgHref(href) : href} ref={ref} {...props} />;
});

export default Link;

type IconName = "eye" | "eye-off" | "lock" | "lock-keyhole-open";
type IconNode = readonly [
  name: "circle" | "path" | "rect",
  attributes: Readonly<Record<string, string>>,
];

const ICON_NODES: Readonly<Record<IconName, readonly IconNode[]>> = {
  eye: [
    [
      "path",
      {
        d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
      },
    ],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
  "eye-off": [
    [
      "path",
      {
        d: "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
      },
    ],
    ["path", { d: "M14.084 14.158a3 3 0 0 1-4.242-4.242" }],
    [
      "path",
      {
        d: "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
      },
    ],
    ["path", { d: "m2 2 20 20" }],
  ],
  lock: [
    ["rect", { width: "18", height: "11", x: "3", y: "11", rx: "2", ry: "2" }],
    ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }],
  ],
  "lock-keyhole-open": [
    ["circle", { cx: "12", cy: "16", r: "1" }],
    ["rect", { width: "18", height: "12", x: "3", y: "10", rx: "2" }],
    ["path", { d: "M7 10V7a5 5 0 0 1 9.33-2.5" }],
  ],
};

/** Lucide SVG geometry, vendored from lucide-static v1.37.0. See THIRD_PARTY_NOTICES.md. */
export function lucideIcon(document: Document, name: IconName): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const [elementName, attributes] of ICON_NODES[name]) {
    const element = document.createElementNS(
      "http://www.w3.org/2000/svg",
      elementName,
    );
    for (const [attribute, value] of Object.entries(attributes))
      element.setAttribute(attribute, value);
    svg.append(element);
  }
  return svg;
}

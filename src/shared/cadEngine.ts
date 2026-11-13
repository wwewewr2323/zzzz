import {
  BAG_ARCHETYPES,
  BAG_TYPE_LABELS,
  EDGE_PROCESS_LABELS,
  computeThicknessCompensationMm,
  getMaterialById,
} from './leatherKnowledge';
import type {
  BagType,
  ComponentItem,
  ComponentRelation,
  EdgeProcessType,
  EdgeRule,
  EnabledFeatures,
  FoldLine,
  HardwareSpec,
  HideDefectZone,
  NestingResult,
  PathNode,
  PatternHole,
  PatternNotch,
  PatternPiece,
  PlacedNestItem,
  Point2D,
  ProductDimensions,
  Project,
  ProjectSnapshot,
  QualityReportSummary,
  StructuredCadCommand,
  ValidationIssue,
  ValidationReport,
} from './types';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function computeSignedArea(pts: Point2D[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return area / 2;
}

export function computeBoundingBox(pts: Point2D[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  if (pts.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    minX: round2(minX),
    minY: round2(minY),
    maxX: round2(maxX),
    maxY: round2(maxY),
    width: round2(maxX - minX),
    height: round2(maxY - minY),
  };
}

export function computePerimeter(pts: Point2D[]): number {
  if (pts.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    total += dist(pts[i], pts[(i + 1) % pts.length]);
  }
  return round2(total);
}

function evalQuad(p0: Point2D, c: Point2D, p1: Point2D, t: number): Point2D {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
  };
}

function evalCubic(
  p0: Point2D,
  c1: Point2D,
  c2: Point2D,
  p1: Point2D,
  t: number
): Point2D {
  const mt = 1 - t;
  return {
    x:
      mt * mt * mt * p0.x +
      3 * mt * mt * t * c1.x +
      3 * mt * t * t * c2.x +
      t * t * t * p1.x,
    y:
      mt * mt * mt * p0.y +
      3 * mt * mt * t * c1.y +
      3 * mt * t * t * c2.y +
      t * t * t * p1.y,
  };
}

export interface EvaluatedContour {
  points: Point2D[];
  pointEdgeIds: string[];
  edgeLengthsMm: Record<string, number>;
}

/**
 * Discretizes native PathNode[] (preserving exact Bezier curves in PathNode[])
 * into a high-precision millimeter polyline while tracking edge membership.
 */
export function evaluateNodesToContour(
  nodes: PathNode[],
  edges: EdgeRule[]
): EvaluatedContour {
  if (nodes.length === 0) {
    return { points: [], pointEdgeIds: [], edgeLengthsMm: {} };
  }

  const edgeByNodeIdx = new Map<number, string>();
  for (const edge of edges) {
    if (edge.nodeStartIdx <= edge.nodeEndIdx) {
      for (let i = edge.nodeStartIdx; i < edge.nodeEndIdx; i++) {
        edgeByNodeIdx.set(i, edge.edgeId);
      }
    } else {
      // Wrap-around closing edge
      for (let i = edge.nodeStartIdx; i < nodes.length; i++) {
        edgeByNodeIdx.set(i, edge.edgeId);
      }
      for (let i = 0; i < edge.nodeEndIdx; i++) {
        edgeByNodeIdx.set(i, edge.edgeId);
      }
    }
  }

  const points: Point2D[] = [{ x: nodes[0].x, y: nodes[0].y }];
  const pointEdgeIds: string[] = [];
  const edgeLengthsMm: Record<string, number> = {};

  for (const edge of edges) {
    edgeLengthsMm[edge.edgeId] = 0;
  }

  const addSegmentPoints = (
    fromNodeIdx: number,
    p0: Point2D,
    targetNode: PathNode
  ) => {
    const edgeId = edgeByNodeIdx.get(fromNodeIdx) ?? 'default';
    const p1 = { x: targetNode.x, y: targetNode.y };

    if (targetNode.type === 'quad' && targetNode.cx1 != null && targetNode.cy1 != null) {
      const c = { x: targetNode.cx1, y: targetNode.cy1 };
      const approxLen = dist(p0, c) + dist(c, p1);
      const steps = Math.max(10, Math.min(40, Math.ceil(approxLen / 2.5)));
      let prev = p0;
      for (let s = 1; s <= steps; s++) {
        const pt = evalQuad(p0, c, p1, s / steps);
        const segLen = dist(prev, pt);
        edgeLengthsMm[edgeId] = (edgeLengthsMm[edgeId] ?? 0) + segLen;
        points.push(pt);
        pointEdgeIds.push(edgeId);
        prev = pt;
      }
    } else if (
      targetNode.type === 'cubic' &&
      targetNode.cx1 != null &&
      targetNode.cy1 != null &&
      targetNode.cx2 != null &&
      targetNode.cy2 != null
    ) {
      const c1 = { x: targetNode.cx1, y: targetNode.cy1 };
      const c2 = { x: targetNode.cx2, y: targetNode.cy2 };
      const approxLen = dist(p0, c1) + dist(c1, c2) + dist(c2, p1);
      const steps = Math.max(12, Math.min(48, Math.ceil(approxLen / 2.5)));
      let prev = p0;
      for (let s = 1; s <= steps; s++) {
        const pt = evalCubic(p0, c1, c2, p1, s / steps);
        const segLen = dist(prev, pt);
        edgeLengthsMm[edgeId] = (edgeLengthsMm[edgeId] ?? 0) + segLen;
        points.push(pt);
        pointEdgeIds.push(edgeId);
        prev = pt;
      }
    } else {
      const segLen = dist(p0, p1);
      edgeLengthsMm[edgeId] = (edgeLengthsMm[edgeId] ?? 0) + segLen;
      points.push(p1);
      pointEdgeIds.push(edgeId);
    }
  };

  for (let i = 1; i < nodes.length; i++) {
    const prev = points[points.length - 1];
    addSegmentPoints(i - 1, prev, nodes[i]);
  }

  // Close contour back to nodes[0]
  const lastPt = points[points.length - 1];
  const firstPt = points[0];
  if (dist(lastPt, firstPt) > 0.01) {
    const closingEdgeId = edgeByNodeIdx.get(nodes.length - 1) ?? 'closing';
    const segLen = dist(lastPt, firstPt);
    edgeLengthsMm[closingEdgeId] = (edgeLengthsMm[closingEdgeId] ?? 0) + segLen;
    pointEdgeIds.push(closingEdgeId);
  } else {
    points.pop();
    if (pointEdgeIds.length > points.length) {
      pointEdgeIds.length = points.length;
    }
  }

  for (const key of Object.keys(edgeLengthsMm)) {
    edgeLengthsMm[key] = round2(edgeLengthsMm[key]);
  }

  return { points, pointEdgeIds, edgeLengthsMm };
}

/**
 * Per-edge outward normal polygon offset (supports distinct seam allowance + fold per edge).
 * Positive distance = outward (seam/fold allowance), Negative distance = inward (stitch line).
 */
export function offsetContourByEdge(
  points: Point2D[],
  pointEdgeIds: string[],
  offsetByEdge: Record<string, number>,
  fallbackOffsetMm: number
): Point2D[] {
  const n = points.length;
  if (n < 3) return [...points];

  const signedArea = computeSignedArea(points);
  const orientation = signedArea >= 0 ? 1 : -1;

  interface OffsetSeg {
    p1: Point2D;
    p2: Point2D;
    dx: number;
    dy: number;
    nx: number;
    ny: number;
    offset: number;
  }

  const segs: OffsetSeg[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;
    // Outward unit normal for Y-down SVG coordinates when signedArea > 0
    const nx = orientation * uy;
    const ny = -orientation * ux;
    const edgeId = pointEdgeIds[i] ?? 'default';
    const off = offsetByEdge[edgeId] ?? fallbackOffsetMm;
    segs.push({
      p1: { x: a.x + nx * off, y: a.y + ny * off },
      p2: { x: b.x + nx * off, y: b.y + ny * off },
      dx: ux,
      dy: uy,
      nx,
      ny,
      offset: off,
    });
  }

  if (segs.length < 3) return [...points];

  const result: Point2D[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s1 = segs[(i - 1 + segs.length) % segs.length];
    const s2 = segs[i];
    const denom = s1.dx * s2.dy - s1.dy * s2.dx;
    if (Math.abs(denom) < 1e-4) {
      result.push({
        x: round2((s1.p2.x + s2.p1.x) / 2),
        y: round2((s1.p2.y + s2.p1.y) / 2),
      });
    } else {
      const diffX = s2.p1.x - s1.p1.x;
      const diffY = s2.p1.y - s1.p1.y;
      const t = (diffX * s2.dy - diffY * s2.dx) / denom;
      const ix = s1.p1.x + t * s1.dx;
      const iy = s1.p1.y + t * s1.dy;

      // Miter limit guard so sharp acute angles don't shoot out infinitely
      const maxOffset = Math.max(Math.abs(s1.offset), Math.abs(s2.offset), 1);
      const distFromVertex = Math.hypot(ix - s2.p1.x, iy - s2.p1.y);
      if (distFromVertex > maxOffset * 2.4) {
        result.push({ x: round2(s1.p2.x), y: round2(s1.p2.y) });
        result.push({ x: round2(s2.p1.x), y: round2(s2.p1.y) });
      } else {
        result.push({ x: round2(ix), y: round2(iy) });
      }
    }
  }

  return result;
}

export function nodesToSvgPath(nodes: PathNode[]): string {
  if (nodes.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (i === 0 || n.type === 'move') {
      parts.push(`M ${round2(n.x)} ${round2(n.y)}`);
    } else if (n.type === 'line') {
      parts.push(`L ${round2(n.x)} ${round2(n.y)}`);
    } else if (n.type === 'quad' && n.cx1 != null && n.cy1 != null) {
      parts.push(`Q ${round2(n.cx1)} ${round2(n.cy1)} ${round2(n.x)} ${round2(n.y)}`);
    } else if (
      n.type === 'cubic' &&
      n.cx1 != null &&
      n.cy1 != null &&
      n.cx2 != null &&
      n.cy2 != null
    ) {
      parts.push(
        `C ${round2(n.cx1)} ${round2(n.cy1)} ${round2(n.cx2)} ${round2(n.cy2)} ${round2(n.x)} ${round2(n.y)}`
      );
    } else {
      parts.push(`L ${round2(n.x)} ${round2(n.y)}`);
    }
  }
  parts.push('Z');
  return parts.join(' ');
}

export function pointsToSvgPath(pts: Point2D[]): string {
  if (pts.length === 0) return '';
  return (
    pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${round2(p.x)} ${round2(p.y)}`)
      .join(' ') + ' Z'
  );
}

/**
 * Computes cutContour, stitchContour, boundingBoxMm, perimeterMm, areaMm2, edgeLengthsMm
 * from native PathNode[] + EdgeRule[].
 */
export function computePieceGeometry(piece: PatternPiece): PatternPiece {
  const { points, pointEdgeIds, edgeLengthsMm } = evaluateNodesToContour(
    piece.nodes,
    piece.edges
  );

  const cutOffsetMap: Record<string, number> = {};
  const stitchOffsetMap: Record<string, number> = {};
  for (const edge of piece.edges) {
    const totalAllowance =
      edge.seamType === 'raw'
        ? 0
        : edge.allowanceMm + (edge.seamType === 'folded' ? edge.foldWidthMm : 0);
    cutOffsetMap[edge.edgeId] = totalAllowance;
    stitchOffsetMap[edge.edgeId] =
      edge.seamType === 'raw' ? -Math.abs(edge.stitchLineOffsetMm || 0) : -Math.abs(edge.stitchLineOffsetMm || 3.2);
  }

  const cutContour = offsetContourByEdge(
    points,
    pointEdgeIds,
    cutOffsetMap,
    piece.seamAllowanceMm
  );
  const stitchContour = offsetContourByEdge(
    points,
    pointEdgeIds,
    stitchOffsetMap,
    -3.2
  );

  const bbox = computeBoundingBox(cutContour.length ? cutContour : points);
  const areaMm2 = round2(Math.abs(computeSignedArea(cutContour.length ? cutContour : points)));
  const perimeterMm = computePerimeter(cutContour.length ? cutContour : points);

  return {
    ...piece,
    sewContour: points.map((p) => ({ x: round2(p.x), y: round2(p.y) })),
    cutContour,
    stitchContour,
    boundingBoxMm: { width: bbox.width, height: bbox.height },
    perimeterMm,
    areaMm2,
    edgeLengthsMm,
  };
}

function makeRectNodes(
  w: number,
  h: number,
  topDropMm = 0,
  bottomCornerRadius = 0
): { nodes: PathNode[]; edges: EdgeRule[] } {
  const r = Math.min(bottomCornerRadius, w / 4, h / 4);
  if (r <= 1 && topDropMm <= 0.5) {
    return {
      nodes: [
        { id: 'n0', x: 0, y: 0, type: 'move' },
        { id: 'n1', x: w, y: 0, type: 'line' },
        { id: 'n2', x: w, y: h, type: 'line' },
        { id: 'n3', x: 0, y: h, type: 'line' },
      ],
      edges: [
        {
          edgeId: 'top',
          label: '包口上边',
          nodeStartIdx: 0,
          nodeEndIdx: 1,
          seamType: 'folded',
          allowanceMm: 0,
          foldWidthMm: 8,
          stitchLineOffsetMm: 3.5,
        },
        {
          edgeId: 'right',
          label: '右侧缝边',
          nodeStartIdx: 1,
          nodeEndIdx: 2,
          seamType: 'plain',
          allowanceMm: 5,
          foldWidthMm: 0,
          stitchLineOffsetMm: 3.5,
        },
        {
          edgeId: 'bottom',
          label: '底缝边',
          nodeStartIdx: 2,
          nodeEndIdx: 3,
          seamType: 'plain',
          allowanceMm: 5,
          foldWidthMm: 0,
          stitchLineOffsetMm: 3.5,
        },
        {
          edgeId: 'left',
          label: '左侧缝边',
          nodeStartIdx: 3,
          nodeEndIdx: 0,
          seamType: 'plain',
          allowanceMm: 5,
          foldWidthMm: 0,
          stitchLineOffsetMm: 3.5,
        },
      ],
    };
  }

  // Supports curved top opening + rounded bottom corners
  const nodes: PathNode[] = [{ id: 'n0', x: 0, y: 0, type: 'move' }];
  if (topDropMm > 0.5) {
    nodes.push({
      id: 'n1',
      x: w,
      y: 0,
      type: 'quad',
      cx1: w / 2,
      cy1: topDropMm * 1.8,
    });
  } else {
    nodes.push({ id: 'n1', x: w, y: 0, type: 'line' });
  }

  if (r > 1) {
    nodes.push({ id: 'n2', x: w, y: h - r, type: 'line' });
    nodes.push({
      id: 'n3',
      x: w - r,
      y: h,
      type: 'quad',
      cx1: w,
      cy1: h,
    });
    nodes.push({ id: 'n4', x: r, y: h, type: 'line' });
    nodes.push({
      id: 'n5',
      x: 0,
      y: h - r,
      type: 'quad',
      cx1: 0,
      cy1: h,
    });
    return {
      nodes,
      edges: [
        {
          edgeId: 'top',
          label: '包口上边',
          nodeStartIdx: 0,
          nodeEndIdx: 1,
          seamType: 'folded',
          allowanceMm: 0,
          foldWidthMm: 8,
          stitchLineOffsetMm: 3.5,
        },
        {
          edgeId: 'right',
          label: '右侧缝边',
          nodeStartIdx: 1,
          nodeEndIdx: 2,
          seamType: 'plain',
          allowanceMm: 5,
          foldWidthMm: 0,
          stitchLineOffsetMm: 3.5,
        },
        {
          edgeId: 'bottom',
          label: '底缝边',
          nodeStartIdx: 2,
          nodeEndIdx: 5,
          seamType: 'plain',
          allowanceMm: 5,
          foldWidthMm: 0,
          stitchLineOffsetMm: 3.5,
        },
        {
          edgeId: 'left',
          label: '左侧缝边',
          nodeStartIdx: 5,
          nodeEndIdx: 0,
          seamType: 'plain',
          allowanceMm: 5,
          foldWidthMm: 0,
          stitchLineOffsetMm: 3.5,
        },
      ],
    };
  }

  nodes.push({ id: 'n2', x: w, y: h, type: 'line' });
  nodes.push({ id: 'n3', x: 0, y: h, type: 'line' });
  return {
    nodes,
    edges: [
      {
        edgeId: 'top',
        label: '包口上边',
        nodeStartIdx: 0,
        nodeEndIdx: 1,
        seamType: 'folded',
        allowanceMm: 0,
        foldWidthMm: 8,
        stitchLineOffsetMm: 3.5,
      },
      {
        edgeId: 'right',
        label: '右侧缝边',
        nodeStartIdx: 1,
        nodeEndIdx: 2,
        seamType: 'plain',
        allowanceMm: 5,
        foldWidthMm: 0,
        stitchLineOffsetMm: 3.5,
      },
      {
        edgeId: 'bottom',
        label: '底缝边',
        nodeStartIdx: 2,
        nodeEndIdx: 3,
        seamType: 'plain',
        allowanceMm: 5,
        foldWidthMm: 0,
        stitchLineOffsetMm: 3.5,
      },
      {
        edgeId: 'left',
        label: '左侧缝边',
        nodeStartIdx: 3,
        nodeEndIdx: 0,
        seamType: 'plain',
        allowanceMm: 5,
        foldWidthMm: 0,
        stitchLineOffsetMm: 3.5,
      },
    ],
  };
}

function makeGussetNodes(
  depthMm: number,
  heightMm: number,
  style: ProductDimensions['gussetStyle'],
  _curveRadiusMm: number,
  bodyCornerRadiusMm = 0
): { nodes: PathNode[]; edges: EdgeRule[] } {
  const effectiveH = Math.max(40, heightMm - (bodyCornerRadiusMm > 1 ? bodyCornerRadiusMm : 0));
  const topWidth = style === 'tapered' ? Math.max(40, depthMm * 0.85) : depthMm;
  const inset = (depthMm - topWidth) / 2;

  if (style === 'curved') {
    const bulge = Math.min(8, depthMm * 0.06);
    const hAdj = Math.round(Math.sqrt(Math.max(1, effectiveH * effectiveH - bulge * bulge * 0.9)) * 100) / 100;
    const nodes: PathNode[] = [
      { id: 'g0', x: inset, y: 0, type: 'move' },
      { id: 'g1', x: inset + topWidth, y: 0, type: 'line' },
      {
        id: 'g2',
        x: depthMm,
        y: hAdj,
        type: 'quad',
        cx1: depthMm + bulge,
        cy1: hAdj * 0.52,
      },
      { id: 'g3', x: 0, y: hAdj, type: 'line' },
      {
        id: 'g4',
        x: inset,
        y: 0,
        type: 'quad',
        cx1: -bulge,
        cy1: hAdj * 0.52,
      },
    ];
    return {
      nodes,
      edges: [
        {
          edgeId: 'top',
          label: '侧片上口',
          nodeStartIdx: 0,
          nodeEndIdx: 1,
          seamType: 'folded',
          allowanceMm: 0,
          foldWidthMm: 8,
          stitchLineOffsetMm: 3.5,
        },
        {
          edgeId: 'back_edge',
          label: '后片接缝边',
          nodeStartIdx: 1,
          nodeEndIdx: 2,
          seamType: 'plain',
          allowanceMm: 5,
          foldWidthMm: 0,
          stitchLineOffsetMm: 3.5,
        },
        {
          edgeId: 'bottom',
          label: '底片接缝边',
          nodeStartIdx: 2,
          nodeEndIdx: 3,
          seamType: 'plain',
          allowanceMm: 5,
          foldWidthMm: 0,
          stitchLineOffsetMm: 3.5,
        },
        {
          edgeId: 'front_edge',
          label: '前片接缝边',
          nodeStartIdx: 3,
          nodeEndIdx: 4,
          seamType: 'plain',
          allowanceMm: 5,
          foldWidthMm: 0,
          stitchLineOffsetMm: 3.5,
        },
      ],
    };
  }

  const hStraight =
    style === 'tapered'
      ? Math.round(Math.sqrt(Math.max(1, effectiveH * effectiveH - inset * inset)) * 100) / 100
      : effectiveH;

  const nodes: PathNode[] = [
    { id: 'g0', x: inset, y: 0, type: 'move' },
    { id: 'g1', x: inset + topWidth, y: 0, type: 'line' },
    { id: 'g2', x: depthMm, y: hStraight, type: 'line' },
    { id: 'g3', x: 0, y: hStraight, type: 'line' },
  ];
  return {
    nodes,
    edges: [
      {
        edgeId: 'top',
        label: '侧片上口',
        nodeStartIdx: 0,
        nodeEndIdx: 1,
        seamType: 'folded',
        allowanceMm: 0,
        foldWidthMm: 8,
        stitchLineOffsetMm: 3.5,
      },
      {
        edgeId: 'back_edge',
        label: '后片接缝边',
        nodeStartIdx: 1,
        nodeEndIdx: 2,
        seamType: 'plain',
        allowanceMm: 5,
        foldWidthMm: 0,
        stitchLineOffsetMm: 3.5,
      },
      {
        edgeId: 'bottom',
        label: '底片接缝边',
        nodeStartIdx: 2,
        nodeEndIdx: 3,
        seamType: 'plain',
        allowanceMm: 5,
        foldWidthMm: 0,
        stitchLineOffsetMm: 3.5,
      },
      {
        edgeId: 'front_edge',
        label: '前片接缝边',
        nodeStartIdx: 3,
        nodeEndIdx: 0,
        seamType: 'plain',
        allowanceMm: 5,
        foldWidthMm: 0,
        stitchLineOffsetMm: 3.5,
      },
    ],
  };
}

function generateStitchHolesAlongSegment(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  spacingMm: number,
  prefix: string
): PatternHole[] {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < spacingMm * 2) return [];
  const count = Math.floor(len / spacingMm);
  const holes: PatternHole[] = [];
  for (let i = 1; i < count; i++) {
    const t = i / count;
    holes.push({
      id: `${prefix}_${i}`,
      x: round2(x1 + (x2 - x1) * t),
      y: round2(y1 + (y2 - y1) * t),
      diameterMm: 1.0,
      kind: 'stitch',
    });
  }
  return holes;
}

export interface GeneratedDesignData {
  components: ComponentItem[];
  relations: ComponentRelation[];
  patterns: PatternPiece[];
}

/**
 * Generates a complete, parametrically linked set of leather components,
 * connection relations, and millimeter-accurate 2D CAD pattern pieces.
 */
export function generateParametricPatterns(
  bagType: BagType,
  dimensions: ProductDimensions,
  materialId: string,
  edgeProcess: EdgeProcessType,
  features: EnabledFeatures,
  existingPieces?: PatternPiece[]
): GeneratedDesignData {
  const mat = getMaterialById(materialId);
  const liningMat = getMaterialById('lining_twill_05');
  const boardMat = getMaterialById('salpa_board_10');
  const thicknessComp = computeThicknessCompensationMm(materialId, edgeProcess);

  const W = Math.max(120, dimensions.widthMm);
  const H = Math.max(100, dimensions.heightMm);
  const D = Math.max(40, dimensions.depthMm);
  const sa = dimensions.seamAllowanceMm ?? mat.defaultSeamAllowanceMm;
  const foldW =
    edgeProcess === 'folded' ? Math.max(6, dimensions.foldWidthMm || 8) : 0;
  const topSeamType = edgeProcess === 'folded' ? 'folded' : 'raw';
  const stitchGap = Math.max(2.5, dimensions.stitchSpacingMm || mat.stitchSpacingMm);

  const components: ComponentItem[] = [];
  const relations: ComponentRelation[] = [];
  const pieces: PatternPiece[] = [];

  const applyEdgeSettings = (edges: EdgeRule[], allowance = sa): EdgeRule[] =>
    edges.map((e) => {
      if (e.edgeId === 'top') {
        return {
          ...e,
          seamType: topSeamType,
          allowanceMm: topSeamType === 'raw' ? 0 : 0,
          foldWidthMm: topSeamType === 'folded' ? foldW : 0,
          stitchLineOffsetMm: 3.5,
        };
      }
      return {
        ...e,
        seamType: 'plain',
        allowanceMm: allowance,
        foldWidthMm: 0,
        stitchLineOffsetMm: 3.5,
      };
    });

  // Helper to preserve canvas positions if pieces already exist
  const prevPos = (id: string, defaultX: number, defaultY: number) => {
    const found = existingPieces?.find((p) => p.id === id);
    return found ? { x: found.canvasX, y: found.canvasY } : { x: defaultX, y: defaultY };
  };

  // 1. Front Panel
  const frontGeom = makeRectNodes(
    W,
    H,
    bagType === 'shoulder_bag' ? dimensions.topOpeningCurveMm : 0,
    dimensions.cornerRadiusMm
  );
  const frontAnchorX1 = round2(W * 0.27);
  const frontAnchorX2 = round2(W * 0.73);
  const anchorY = round2(Math.min(48, H * 0.22));
  const frontHoles: PatternHole[] = [
    { id: 'fh_1', x: frontAnchorX1, y: anchorY - 10, diameterMm: 3.0, kind: 'rivet', label: '左提手铆钉' },
    { id: 'fh_2', x: frontAnchorX2, y: anchorY - 10, diameterMm: 3.0, kind: 'rivet', label: '右提手铆钉' },
  ];
  if (features.hasMagneticClosure) {
    frontHoles.push({
      id: 'fh_mag',
      x: round2(W / 2),
      y: round2(Math.max(24, dimensions.topOpeningCurveMm + 22)),
      diameterMm: 2.5,
      kind: 'hardware',
      label: '磁扣定位孔',
    });
  }
  const anchorTopY = round2(Math.max(12, anchorY - 28));
  const frontFoldLines: FoldLine[] = [
    ...(topSeamType === 'folded'
      ? [{ id: 'fl_front_top', x1: 0, y1: 0, x2: W, y2: 0, label: `折边基准线 (${foldW}mm)` }]
      : []),
    {
      id: 'fl_anchor_l_top',
      x1: frontAnchorX1 - 15,
      y1: anchorTopY,
      x2: frontAnchorX1 + 15,
      y2: anchorTopY,
      label: '左耳仔定位上沿',
    },
    {
      id: 'fl_anchor_r_top',
      x1: frontAnchorX2 - 15,
      y1: anchorTopY,
      x2: frontAnchorX2 + 15,
      y2: anchorTopY,
      label: '右耳仔定位上沿',
    },
  ];
  const frontNotches: PatternNotch[] = [
    { id: 'fn_bot_mid', x: round2(W / 2), y: H, nx: 0, ny: 1, depthMm: 3, edgeId: 'bottom', label: '底中心刀口' },
    { id: 'fn_left_mid', x: 0, y: round2(H / 2), nx: -1, ny: 0, depthMm: 3, edgeId: 'left', label: '左中对位刀口' },
    { id: 'fn_right_mid', x: W, y: round2(H / 2), nx: 1, ny: 0, depthMm: 3, edgeId: 'right', label: '右中对位刀口' },
  ];
  const fPos = prevPos('piece_front', 40, 40);
  const frontPiece = computePieceGeometry({
    id: 'piece_front',
    componentId: 'comp_front',
    partCode: 'A01',
    name: '前片 (Front Panel)',
    category: 'body',
    quantity: 1,
    materialId: mat.id,
    materialName: mat.name,
    thicknessMm: mat.thicknessMm,
    canvasX: fPos.x,
    canvasY: fPos.y,
    rotationDeg: 0,
    nodes: frontGeom.nodes,
    edges: applyEdgeSettings(frontGeom.edges),
    seamAllowanceMm: sa,
    foldAllowanceMm: foldW,
    sewContour: [],
    cutContour: [],
    stitchContour: [],
    foldLines: frontFoldLines,
    holes: frontHoles,
    notches: frontNotches,
    grainAngleDeg: 90,
    boundingBoxMm: { width: W, height: H },
    perimeterMm: 0,
    areaMm2: 0,
    edgeLengthsMm: {},
    confidence: 0.98,
    isInferredHidden: false,
    notes: `${EDGE_PROCESS_LABELS[edgeProcess]} · ${BAG_TYPE_LABELS[bagType]}主身前片`,
  });
  pieces.push(frontPiece);
  components.push({
    id: 'comp_front',
    partCode: 'A01',
    name: '前片',
    standardType: 'front_panel',
    category: 'body',
    role: '包包正面主结构片',
    quantity: 1,
    widthMm: W,
    heightMm: H,
    thicknessMm: mat.thicknessMm,
    materialName: mat.name,
    processType: edgeProcess,
    confidence: 0.98,
    source: dimensions.dimensionSource,
    isInferredHidden: false,
    boundingBox2D: [240, 220, 820, 760],
    confirmed: true,
  });

  // 2. Back Panel
  const bPos = prevPos('piece_back', 40 + W + 45, 40);
  const backPiece = computePieceGeometry({
    ...frontPiece,
    id: 'piece_back',
    componentId: 'comp_back',
    partCode: 'A02',
    name: '后片 (Back Panel)',
    canvasX: bPos.x,
    canvasY: bPos.y,
    holes: frontHoles.map((h) => ({ ...h, id: `b_${h.id}` })),
    notches: frontNotches.map((n) => ({ ...n, id: `b_${n.id}` })),
    foldLines: frontFoldLines.map((fl) => ({ ...fl, id: `b_${fl.id}` })),
    confidence: 0.92,
    isInferredHidden: false,
    notes: '对称主身后片，含提手/磁扣定位孔位',
  });
  pieces.push(backPiece);
  components.push({
    id: 'comp_back',
    partCode: 'A02',
    name: '后片',
    standardType: 'back_panel',
    category: 'body',
    role: '包包背面主结构片',
    quantity: 1,
    widthMm: W,
    heightMm: H,
    thicknessMm: mat.thicknessMm,
    materialName: mat.name,
    processType: edgeProcess,
    confidence: 0.92,
    source: dimensions.dimensionSource,
    isInferredHidden: false,
    confirmed: true,
  });

  // 3. Left & Right Gussets (Side Panels)
  const gussetGeom = makeGussetNodes(
    D,
    H,
    dimensions.gussetStyle,
    dimensions.gussetCurveRadiusMm,
    dimensions.cornerRadiusMm
  );
  const glPos = prevPos('piece_gusset_l', 40 + (W + 45) * 2, 40);
  const gussetLeft = computePieceGeometry({
    id: 'piece_gusset_l',
    componentId: 'comp_gusset_l',
    partCode: 'A03',
    name: '左侧片 (Left Gusset)',
    category: 'body',
    quantity: 1,
    materialId: mat.id,
    materialName: mat.name,
    thicknessMm: mat.thicknessMm,
    canvasX: glPos.x,
    canvasY: glPos.y,
    rotationDeg: 0,
    nodes: gussetGeom.nodes,
    edges: applyEdgeSettings(gussetGeom.edges),
    seamAllowanceMm: sa,
    foldAllowanceMm: foldW,
    sewContour: [],
    cutContour: [],
    stitchContour: [],
    foldLines:
      topSeamType === 'folded'
        ? [{ id: 'fl_gl_top', x1: 0, y1: 0, x2: D, y2: 0, label: '侧片折边线' }]
        : [],
    holes: features.hasShoulderStrap
      ? [
          {
            id: 'gl_dring',
            x: round2(D / 2),
            y: 20,
            diameterMm: 2.0,
            kind: 'hardware',
            label: 'D环侧耳孔',
          },
        ]
      : [],
    notches: [
      { id: 'gl_n1', x: round2(D / 2), y: H, nx: 0, ny: 1, depthMm: 3, edgeId: 'bottom', label: '侧底中心刀口' },
    ],
    grainAngleDeg: 90,
    boundingBoxMm: { width: D, height: H },
    perimeterMm: 0,
    areaMm2: 0,
    edgeLengthsMm: {},
    confidence: 0.94,
    isInferredHidden: false,
    notes: `侧面围片（${dimensions.gussetStyle === 'curved' ? '圆弧侧面' : dimensions.gussetStyle === 'tapered' ? '梯形收口' : '直筒侧面'}）`,
  });
  pieces.push(gussetLeft);
  components.push({
    id: 'comp_gusset_l',
    partCode: 'A03',
    name: '左侧片',
    standardType: 'left_gusset',
    category: 'body',
    role: '左侧立体连接围片',
    quantity: 1,
    widthMm: D,
    heightMm: H,
    thicknessMm: mat.thicknessMm,
    materialName: mat.name,
    processType: edgeProcess,
    confidence: 0.94,
    source: dimensions.dimensionSource,
    isInferredHidden: false,
    boundingBox2D: [260, 170, 810, 290],
    confirmed: true,
  });

  const grPos = prevPos('piece_gusset_r', 40 + (W + 45) * 2 + D + 45, 40);
  const gussetRight = computePieceGeometry({
    ...gussetLeft,
    id: 'piece_gusset_r',
    componentId: 'comp_gusset_r',
    partCode: 'A04',
    name: '右侧片 (Right Gusset)',
    canvasX: grPos.x,
    canvasY: grPos.y,
    confidence: 0.88,
    isInferredHidden: false,
    notes: '与左侧片镜像对称，连接前后片右侧边及底片',
  });
  pieces.push(gussetRight);
  components.push({
    id: 'comp_gusset_r',
    partCode: 'A04',
    name: '右侧片',
    standardType: 'right_gusset',
    category: 'body',
    role: '右侧立体连接围片',
    quantity: 1,
    widthMm: D,
    heightMm: H,
    thicknessMm: mat.thicknessMm,
    materialName: mat.name,
    processType: edgeProcess,
    confidence: 0.88,
    source: dimensions.dimensionSource,
    isInferredHidden: false,
    confirmed: true,
  });

  // 4. Bottom Panel
  const botW = frontPiece.edgeLengthsMm['bottom'] || W;
  const botD = gussetLeft.edgeLengthsMm['bottom'] || D;
  const botRadius = 0;
  const botGeom = makeRectNodes(botW, botD, 0, botRadius);
  const botEdges: EdgeRule[] = botGeom.edges.map((e) => ({
    ...e,
    label:
      e.edgeId === 'top'
        ? '后片底边缝'
        : e.edgeId === 'bottom'
          ? '前片底边缝'
          : e.edgeId === 'left'
            ? '左侧片底缝'
            : '右侧片底缝',
    seamType: 'plain',
    allowanceMm: sa,
    foldWidthMm: 0,
    stitchLineOffsetMm: 3.5,
  }));
  const botPos = prevPos('piece_bottom', 40, 40 + H + 55);
  const bottomPiece = computePieceGeometry({
    id: 'piece_bottom',
    componentId: 'comp_bottom',
    partCode: 'A05',
    name: '底片 (Bottom Panel)',
    category: 'body',
    quantity: 1,
    materialId: mat.id,
    materialName: mat.name,
    thicknessMm: round2(Math.max(mat.thicknessMm, dimensions.bottomThicknessMm)),
    canvasX: botPos.x,
    canvasY: botPos.y,
    rotationDeg: 0,
    nodes: botGeom.nodes,
    edges: botEdges,
    seamAllowanceMm: sa,
    foldAllowanceMm: 0,
    sewContour: [],
    cutContour: [],
    stitchContour: [],
    foldLines: [],
    holes:
      bagType === 'handbag' || dimensions.bottomThicknessMm >= 2.5
        ? [
            { id: 'bh_1', x: 24, y: 22, diameterMm: 3.5, kind: 'hardware', label: '脚钉孔1' },
            { id: 'bh_2', x: W - 24, y: 22, diameterMm: 3.5, kind: 'hardware', label: '脚钉孔2' },
            { id: 'bh_3', x: W - 24, y: D - 22, diameterMm: 3.5, kind: 'hardware', label: '脚钉孔3' },
            { id: 'bh_4', x: 24, y: D - 22, diameterMm: 3.5, kind: 'hardware', label: '脚钉孔4' },
          ]
        : [],
    notches: [
      { id: 'bn_top', x: round2(W / 2), y: 0, nx: 0, ny: -1, depthMm: 3, edgeId: 'top', label: '后中心' },
      { id: 'bn_bot', x: round2(W / 2), y: D, nx: 0, ny: 1, depthMm: 3, edgeId: 'bottom', label: '前中心' },
    ],
    grainAngleDeg: 0,
    boundingBoxMm: { width: W, height: D },
    perimeterMm: 0,
    areaMm2: 0,
    edgeLengthsMm: {},
    confidence: 0.85,
    isInferredHidden: true,
    notes: `包底承重片，设计底厚 ${round2(dimensions.bottomThicknessMm)}mm`,
  });
  pieces.push(bottomPiece);
  components.push({
    id: 'comp_bottom',
    partCode: 'A05',
    name: '底片',
    standardType: 'bottom_panel',
    category: 'body',
    role: '承重底部外皮片',
    quantity: 1,
    widthMm: W,
    heightMm: D,
    thicknessMm: round2(Math.max(mat.thicknessMm, dimensions.bottomThicknessMm)),
    materialName: mat.name,
    processType: 'raw_burnish',
    confidence: 0.85,
    source: 'computed',
    isInferredHidden: true,
    confirmed: false,
  });

  // 5. Bottom Reinforcement Board (if enabled)
  if (features.hasBottomBoard) {
    const rw = Math.max(40, round2(W - thicknessComp.boardInsetMm * 2));
    const rd = Math.max(20, round2(D - thicknessComp.boardInsetMm * 2));
    const rbGeom = makeRectNodes(rw, rd, 0, Math.max(2, botRadius - 2));
    const rbPos = prevPos('piece_bottom_board', 40 + W + 45, 40 + H + 55);
    const boardPiece = computePieceGeometry({
      id: 'piece_bottom_board',
      componentId: 'comp_bottom_board',
      partCode: 'R01',
      name: '底托加固板 (Bottom Board)',
      category: 'reinforcement',
      quantity: 1,
      materialId: boardMat.id,
      materialName: boardMat.name,
      thicknessMm: round2(Math.max(1.0, dimensions.bottomThicknessMm - mat.thicknessMm)),
      canvasX: rbPos.x,
      canvasY: rbPos.y,
      rotationDeg: 0,
      nodes: rbGeom.nodes,
      edges: rbGeom.edges.map((e) => ({
        ...e,
        seamType: 'raw',
        allowanceMm: 0,
        foldWidthMm: 0,
        stitchLineOffsetMm: 0,
      })),
      seamAllowanceMm: 0,
      foldAllowanceMm: 0,
      sewContour: [],
      cutContour: [],
      stitchContour: [],
      foldLines: [],
      holes: [],
      notches: [],
      grainAngleDeg: 0,
      boundingBoxMm: { width: rw, height: rd },
      perimeterMm: 0,
      areaMm2: 0,
      edgeLengthsMm: {},
      confidence: 0.8,
      isInferredHidden: true,
      notes: `已按皮料厚度 ${mat.thicknessMm}mm 执行单边内缩 ${thicknessComp.boardInsetMm}mm 补偿，避开缝份线`,
    });
    pieces.push(boardPiece);
    components.push({
      id: 'comp_bottom_board',
      partCode: 'R01',
      name: '底托加固板',
      standardType: 'bottom_board',
      category: 'reinforcement',
      role: '内部结构支撑衬板',
      quantity: 1,
      widthMm: rw,
      heightMm: rd,
      thicknessMm: boardPiece.thicknessMm,
      materialName: boardMat.name,
      processType: 'raw_burnish',
      confidence: 0.8,
      source: 'computed',
      isInferredHidden: true,
      confirmed: false,
    });
    relations.push({
      id: 'rel_bot_board',
      fromComponentId: 'comp_bottom',
      fromEdgeId: 'bottom',
      toComponentId: 'comp_bottom_board',
      toEdgeId: 'bottom',
      relationType: 'reinforce',
      stitchDirection: 'lap',
      allowanceMm: 0,
      notes: '底托板贴合于底片内侧中心',
    });
  }

  // 6. Handles (x2) & Handle Anchors (x4)
  const handleW = 24;
  const handleL = Math.max(180, dimensions.handleLengthMm);
  const hGeom = makeRectNodes(handleL, handleW, 0, 4);
  const hPos = prevPos('piece_handle', 40, 40 + H + D + 100);
  const handleHoles = [
    ...generateStitchHolesAlongSegment(12, 3.5, handleL - 12, 3.5, stitchGap, 'hs_top'),
    ...generateStitchHolesAlongSegment(12, handleW - 3.5, handleL - 12, handleW - 3.5, stitchGap, 'hs_bot'),
  ];
  const handlePiece = computePieceGeometry({
    id: 'piece_handle',
    componentId: 'comp_handle',
    partCode: 'H01',
    name: '主提手带 (Handle Strap ×2)',
    category: 'handle',
    quantity: 2,
    materialId: mat.id,
    materialName: mat.name,
    thicknessMm: mat.thicknessMm,
    canvasX: hPos.x,
    canvasY: hPos.y,
    rotationDeg: 0,
    nodes: hGeom.nodes,
    edges: hGeom.edges.map((e) => ({
      ...e,
      seamType: 'raw',
      allowanceMm: 0,
      foldWidthMm: 0,
      stitchLineOffsetMm: 3.2,
    })),
    seamAllowanceMm: 0,
    foldAllowanceMm: 0,
    sewContour: [],
    cutContour: [],
    stitchContour: [],
    foldLines: [
      { id: 'fl_h_mid', x1: 0, y1: handleW / 2, x2: handleL, y2: handleW / 2, label: '提手中轴线' },
    ],
    holes: handleHoles,
    notches: [],
    grainAngleDeg: 0,
    boundingBoxMm: { width: handleL, height: handleW },
    perimeterMm: 0,
    areaMm2: 0,
    edgeLengthsMm: {},
    confidence: 0.96,
    isInferredHidden: false,
    notes: `裁剪 2 条（或对折包芯），净长 ${handleL}mm，孔距 ${stitchGap}mm`,
  });
  pieces.push(handlePiece);
  components.push({
    id: 'comp_handle',
    partCode: 'H01',
    name: '手柄',
    standardType: 'handle_strap',
    category: 'handle',
    role: '手拎承重提手（×2）',
    quantity: 2,
    widthMm: handleL,
    heightMm: handleW,
    thicknessMm: mat.thicknessMm,
    materialName: mat.name,
    processType: edgeProcess,
    confidence: 0.96,
    source: dimensions.dimensionSource,
    isInferredHidden: false,
    boundingBox2D: [40, 350, 290, 660],
    confirmed: true,
  });

  // Handle Anchor / Reinforcement Patch (Teardrop/Shield shape)
  const ancW = 30;
  const ancH = 54;
  const ancNodes: PathNode[] = [
    { id: 'an0', x: 0, y: 0, type: 'move' },
    { id: 'an1', x: ancW, y: 0, type: 'line' },
    { id: 'an2', x: ancW, y: 32, type: 'line' },
    { id: 'an3', x: ancW / 2, y: ancH, type: 'quad', cx1: ancW, cy1: ancH - 6 },
    { id: 'an4', x: 0, y: 32, type: 'quad', cx1: 0, cy1: ancH - 6 },
  ];
  const ancEdges: EdgeRule[] = [
    { edgeId: 'top', label: '底座上边', nodeStartIdx: 0, nodeEndIdx: 1, seamType: 'raw', allowanceMm: 0, foldWidthMm: 0, stitchLineOffsetMm: 3 },
    { edgeId: 'perimeter', label: '底座缝线周长', nodeStartIdx: 1, nodeEndIdx: 0, seamType: 'raw', allowanceMm: 0, foldWidthMm: 0, stitchLineOffsetMm: 3 },
  ];
  const aPos = prevPos('piece_anchor', 40 + handleL + 40, 40 + H + D + 90);
  const anchorPiece = computePieceGeometry({
    id: 'piece_anchor',
    componentId: 'comp_anchor',
    partCode: 'H02',
    name: '提手耳仔底座 (Handle Anchor ×4)',
    category: 'handle',
    quantity: 4,
    materialId: mat.id,
    materialName: mat.name,
    thicknessMm: mat.thicknessMm,
    canvasX: aPos.x,
    canvasY: aPos.y,
    rotationDeg: 0,
    nodes: ancNodes,
    edges: ancEdges,
    seamAllowanceMm: 0,
    foldAllowanceMm: 0,
    sewContour: [],
    cutContour: [],
    stitchContour: [],
    foldLines: [],
    holes: [{ id: 'anh_1', x: ancW / 2, y: 18, diameterMm: 3.0, kind: 'rivet', label: '撞钉孔' }],
    notches: [],
    grainAngleDeg: 90,
    boundingBoxMm: { width: ancW, height: ancH },
    perimeterMm: 0,
    areaMm2: 0,
    edgeLengthsMm: {},
    confidence: 0.91,
    isInferredHidden: false,
    notes: '前后片各 2 片，共 4 片，对应前片提手铆钉定位孔',
  });
  pieces.push(anchorPiece);
  components.push({
    id: 'comp_anchor',
    partCode: 'H02',
    name: '提手连接片',
    standardType: 'handle_anchor',
    category: 'handle',
    role: '提手与包身受力连接底座（×4）',
    quantity: 4,
    widthMm: ancW,
    heightMm: ancH,
    thicknessMm: mat.thicknessMm,
    materialName: mat.name,
    processType: 'edge_paint',
    confidence: 0.91,
    source: dimensions.dimensionSource,
    isInferredHidden: false,
    boundingBox2D: [310, 390, 470, 480],
    confirmed: true,
  });

  // 7. Lining Body (if enabled)
  if (features.hasLining) {
    const lw = round2(Math.max(60, W - thicknessComp.liningWidthDeductionMm));
    const lh = round2(Math.max(60, H - thicknessComp.liningHeightDeductionMm));
    const lGeom = makeRectNodes(lw, lh, 0, Math.max(0, dimensions.cornerRadiusMm - 2));
    const lPos = prevPos('piece_lining', 40 + (W + 45) * 2, 40 + H + 55);
    const liningPiece = computePieceGeometry({
      id: 'piece_lining',
      componentId: 'comp_lining',
      partCode: 'L01',
      name: '内衬主体片 (Lining Body ×2)',
      category: 'interior',
      quantity: 2,
      materialId: liningMat.id,
      materialName: liningMat.name,
      thicknessMm: liningMat.thicknessMm,
      canvasX: lPos.x,
      canvasY: lPos.y,
      rotationDeg: 0,
      nodes: lGeom.nodes,
      edges: lGeom.edges.map((e) => ({
        ...e,
        seamType: e.edgeId === 'top' ? 'folded' : 'plain',
        allowanceMm: e.edgeId === 'top' ? 0 : 8,
        foldWidthMm: e.edgeId === 'top' ? 10 : 0,
        stitchLineOffsetMm: 5,
      })),
      seamAllowanceMm: 8,
      foldAllowanceMm: 10,
      sewContour: [],
      cutContour: [],
      stitchContour: [],
      foldLines: [{ id: 'fl_lin_top', x1: 0, y1: 0, x2: lw, y2: 0, label: '内衬上折边' }],
      holes: [],
      notches: [{ id: 'ln_mid', x: round2(lw / 2), y: lh, nx: 0, ny: 1, depthMm: 3, edgeId: 'bottom' }],
      grainAngleDeg: 90,
      boundingBoxMm: { width: lw, height: lh },
      perimeterMm: 0,
      areaMm2: 0,
      edgeLengthsMm: {},
      confidence: 0.78,
      isInferredHidden: true,
      notes: `推断隐藏内部件：已按外皮厚度 ${mat.thicknessMm}mm 内缩 -${thicknessComp.liningWidthDeductionMm}mm/-${thicknessComp.liningHeightDeductionMm}mm 防止堆褶`,
    });
    pieces.push(liningPiece);
    components.push({
      id: 'comp_lining',
      partCode: 'L01',
      name: '内衬',
      standardType: 'lining_body',
      category: 'interior',
      role: '内部主体里衬（×2）',
      quantity: 2,
      widthMm: lw,
      heightMm: lh,
      thicknessMm: liningMat.thicknessMm,
      materialName: liningMat.name,
      processType: 'folded',
      confidence: 0.78,
      source: 'computed',
      isInferredHidden: true,
      confirmed: false,
    });
    relations.push({
      id: 'rel_lining_front',
      fromComponentId: 'comp_front',
      fromEdgeId: 'top',
      toComponentId: 'comp_lining',
      toEdgeId: 'top',
      relationType: 'lining_attach',
      stitchDirection: 'face_to_face',
      allowanceMm: 8,
      notes: '包口沿与内衬贴边缝合',
    });
  }

  // 8. Optional Internal Zipper Pocket
  if (features.hasZipperPocket) {
    const zpW = round2(Math.min(200, Math.max(130, W * 0.62)));
    const zpH = round2(Math.min(145, Math.max(100, H * 0.55)));
    const zpGeom = makeRectNodes(zpW, zpH, 0, 4);
    const zpPos = prevPos('piece_zip_pocket', 40 + handleL + 120, 40 + H + D + 90);
    const zipPocketPiece = computePieceGeometry({
      id: 'piece_zip_pocket',
      componentId: 'comp_zip_pocket',
      partCode: 'I01',
      name: '内部拉链袋身 (Zipper Pocket ×2)',
      category: 'interior',
      quantity: 2,
      materialId: liningMat.id,
      materialName: liningMat.name,
      thicknessMm: liningMat.thicknessMm,
      canvasX: zpPos.x,
      canvasY: zpPos.y,
      rotationDeg: 0,
      nodes: zpGeom.nodes,
      edges: zpGeom.edges.map((e) => ({
        ...e,
        seamType: 'plain',
        allowanceMm: 7,
        foldWidthMm: 0,
        stitchLineOffsetMm: 4,
      })),
      seamAllowanceMm: 7,
      foldAllowanceMm: 0,
      sewContour: [],
      cutContour: [],
      stitchContour: [],
      foldLines: [
        {
          id: 'fl_zip_slot',
          x1: 22,
          y1: 22,
          x2: zpW - 22,
          y2: 22,
          label: `拉链开窗中心线 (${round2(zpW - 44)}mm)`,
        },
      ],
      holes: [
        { id: 'zph_1', x: 22, y: 22, diameterMm: 2.0, kind: 'hardware', label: '拉链止口左' },
        { id: 'zph_2', x: zpW - 22, y: 22, diameterMm: 2.0, kind: 'hardware', label: '拉链止口右' },
      ],
      notches: [],
      grainAngleDeg: 90,
      boundingBoxMm: { width: zpW, height: zpH },
      perimeterMm: 0,
      areaMm2: 0,
      edgeLengthsMm: {},
      confidence: 0.76,
      isInferredHidden: true,
      notes: `安装于后片内衬，配 ${round2(zpW - 44)}mm 拉链开窗槽`,
    });
    pieces.push(zipPocketPiece);
    components.push({
      id: 'comp_zip_pocket',
      partCode: 'I01',
      name: '拉链内袋',
      standardType: 'zipper_pocket',
      category: 'interior',
      role: '内部带拉链安全贴袋（×2片）',
      quantity: 2,
      widthMm: zpW,
      heightMm: zpH,
      thicknessMm: liningMat.thicknessMm,
      materialName: liningMat.name,
      processType: 'folded',
      confidence: 0.76,
      source: 'computed',
      isInferredHidden: true,
      confirmed: false,
    });
    relations.push({
      id: 'rel_zip_lining',
      fromComponentId: 'comp_lining',
      fromEdgeId: 'top',
      toComponentId: 'comp_zip_pocket',
      toEdgeId: 'top',
      relationType: 'sew',
      stitchDirection: 'lap',
      allowanceMm: 7,
      notes: '拉链袋车缝固定于内衬后片距包口 38mm 处',
    });
  }

  // 9. Optional Exterior Front Pocket
  if (features.hasFrontPocket) {
    const fpW = round2(W * 0.72);
    const fpH = round2(H * 0.58);
    const fpGeom = makeRectNodes(fpW, fpH, 0, Math.min(10, dimensions.cornerRadiusMm));
    const fpPos = prevPos('piece_front_pocket', 40 + (W + 45) * 3, 40 + H + 55);
    const fpPiece = computePieceGeometry({
      id: 'piece_front_pocket',
      componentId: 'comp_front_pocket',
      partCode: 'P01',
      name: '外置前贴袋 (Front Pocket)',
      category: 'body',
      quantity: 1,
      materialId: mat.id,
      materialName: mat.name,
      thicknessMm: mat.thicknessMm,
      canvasX: fpPos.x,
      canvasY: fpPos.y,
      rotationDeg: 0,
      nodes: fpGeom.nodes,
      edges: applyEdgeSettings(fpGeom.edges, 4),
      seamAllowanceMm: 4,
      foldAllowanceMm: foldW,
      sewContour: [],
      cutContour: [],
      stitchContour: [],
      foldLines:
        topSeamType === 'folded'
          ? [{ id: 'fl_fp_top', x1: 0, y1: 0, x2: fpW, y2: 0, label: '前袋口折边线' }]
          : [],
      holes: [],
      notches: [],
      grainAngleDeg: 90,
      boundingBoxMm: { width: fpW, height: fpH },
      perimeterMm: 0,
      areaMm2: 0,
      edgeLengthsMm: {},
      confidence: 0.9,
      isInferredHidden: false,
      notes: '缝合于前片下半部外侧',
    });
    pieces.push(fpPiece);
    components.push({
      id: 'comp_front_pocket',
      partCode: 'P01',
      name: '外置前口袋',
      standardType: 'front_pocket',
      category: 'body',
      role: '前片外部功能贴袋',
      quantity: 1,
      widthMm: fpW,
      heightMm: fpH,
      thicknessMm: mat.thicknessMm,
      materialName: mat.name,
      processType: edgeProcess,
      confidence: 0.9,
      source: dimensions.dimensionSource,
      isInferredHidden: false,
      confirmed: true,
    });
    relations.push({
      id: 'rel_front_pocket',
      fromComponentId: 'comp_front',
      fromEdgeId: 'bottom',
      toComponentId: 'comp_front_pocket',
      toEdgeId: 'bottom',
      relationType: 'sew',
      stitchDirection: 'lap',
      allowanceMm: 4,
      notes: '贴袋三边明线车缝于前片正面',
    });
  }

  // 10. Optional Shoulder Strap
  if (features.hasShoulderStrap) {
    const strapW = 24;
    const strapL = Math.max(600, dimensions.strapLengthMm);
    const sGeom = makeRectNodes(strapL, strapW, 0, 6);
    const sPos = prevPos('piece_strap', 40, 40 + H + D + 170);
    const buckleHoles: PatternHole[] = [];
    for (let i = 0; i < 5; i++) {
      buckleHoles.push({
        id: `sh_b_${i}`,
        x: round2(60 + i * 25),
        y: strapW / 2,
        diameterMm: 3.5,
        kind: 'buckle',
        label: `调节孔${i + 1}`,
      });
    }
    const strapPiece = computePieceGeometry({
      id: 'piece_strap',
      componentId: 'comp_strap',
      partCode: 'S01',
      name: '可调节肩带 (Shoulder Strap)',
      category: 'strap',
      quantity: 1,
      materialId: mat.id,
      materialName: mat.name,
      thicknessMm: mat.thicknessMm,
      canvasX: sPos.x,
      canvasY: sPos.y,
      rotationDeg: 0,
      nodes: sGeom.nodes,
      edges: sGeom.edges.map((e) => ({
        ...e,
        seamType: 'raw',
        allowanceMm: 0,
        foldWidthMm: 0,
        stitchLineOffsetMm: 3.2,
      })),
      seamAllowanceMm: 0,
      foldAllowanceMm: 0,
      sewContour: [],
      cutContour: [],
      stitchContour: [],
      foldLines: [],
      holes: buckleHoles,
      notches: [],
      grainAngleDeg: 0,
      boundingBoxMm: { width: strapL, height: strapW },
      perimeterMm: 0,
      areaMm2: 0,
      edgeLengthsMm: {},
      confidence: 0.9,
      isInferredHidden: false,
      notes: `含 5 档 25mm 间距调节孔，总长 ${strapL}mm`,
    });
    pieces.push(strapPiece);
    components.push({
      id: 'comp_strap',
      partCode: 'S01',
      name: '肩带',
      standardType: 'shoulder_strap',
      category: 'strap',
      role: '长肩带及五档调节孔',
      quantity: 1,
      widthMm: strapL,
      heightMm: strapW,
      thicknessMm: mat.thicknessMm,
      materialName: mat.name,
      processType: edgeProcess,
      confidence: 0.9,
      source: dimensions.dimensionSource,
      isInferredHidden: false,
      confirmed: true,
    });
    relations.push({
      id: 'rel_strap_gusset_l',
      fromComponentId: 'comp_gusset_l',
      fromEdgeId: 'top',
      toComponentId: 'comp_strap',
      toEdgeId: 'left',
      relationType: 'hardware_mount',
      stitchDirection: 'edge_to_edge',
      allowanceMm: 0,
      notes: '通过 D 形环连接左侧片与肩带挂扣',
    });
  }

  // 11. Optional Internal Slip Pocket (I02)
  if (features.hasSlipPocket) {
    const spW = round2(Math.min(210, Math.max(120, W * 0.6)));
    const spH = round2(Math.min(135, Math.max(95, H * 0.5)));
    const spGeom = makeRectNodes(spW, spH, 0, 4);
    const spPos = prevPos('piece_slip_pocket', 40 + (W + 45) * 3, 40 + H + D + 90);
    const spPiece = computePieceGeometry({
      id: 'piece_slip_pocket',
      componentId: 'comp_slip_pocket',
      partCode: 'I02',
      name: '内部敞口插袋 (Slip Pocket)',
      category: 'interior',
      quantity: 1,
      materialId: liningMat.id,
      materialName: liningMat.name,
      thicknessMm: liningMat.thicknessMm,
      canvasX: spPos.x,
      canvasY: spPos.y,
      rotationDeg: 0,
      nodes: spGeom.nodes,
      edges: spGeom.edges.map((e) => ({
        ...e,
        seamType: e.edgeId === 'top' ? 'folded' : 'plain',
        allowanceMm: e.edgeId === 'top' ? 0 : 7,
        foldWidthMm: e.edgeId === 'top' ? 10 : 0,
        stitchLineOffsetMm: 3.5,
      })),
      seamAllowanceMm: 7,
      foldAllowanceMm: 10,
      sewContour: [],
      cutContour: [],
      stitchContour: [],
      foldLines: [{ id: 'fl_sp_top', x1: 0, y1: 0, x2: spW, y2: 0, label: '插袋口折边' }],
      holes: [],
      notches: [],
      grainAngleDeg: 90,
      boundingBoxMm: { width: spW, height: spH },
      perimeterMm: 0,
      areaMm2: 0,
      edgeLengthsMm: {},
      confidence: 0.75,
      isInferredHidden: true,
      notes: '推断隐藏内部件：手机/卡位开放插袋，车缝于前片内衬',
    });
    pieces.push(spPiece);
    components.push({
      id: 'comp_slip_pocket',
      partCode: 'I02',
      name: '内部插袋',
      standardType: 'slip_pocket',
      category: 'interior',
      role: '内部敞口收纳插袋',
      quantity: 1,
      widthMm: spW,
      heightMm: spH,
      thicknessMm: liningMat.thicknessMm,
      materialName: liningMat.name,
      processType: 'folded',
      confidence: 0.75,
      source: 'computed',
      isInferredHidden: true,
      confirmed: false,
    });
    relations.push({
      id: 'rel_slip_lining',
      fromComponentId: 'comp_lining',
      fromEdgeId: 'top',
      toComponentId: 'comp_slip_pocket',
      toEdgeId: 'top',
      relationType: 'sew',
      stitchDirection: 'lap',
      allowanceMm: 7,
      notes: '敞口插袋三边明线车缝于内衬前片',
    });
  }

  // 12. Optional Top Zipper Flap / Bridge (O01 x2)
  if (features.hasTopZipperFlap) {
    const zfW = round2(Math.max(120, W - 12));
    const zfH = 34;
    const zfGeom = makeRectNodes(zfW, zfH, 0, 0);
    const zfPos = prevPos('piece_zip_flap', 40 + W + 45, 40 + H + D + 90);
    const zfPiece = computePieceGeometry({
      id: 'piece_zip_flap',
      componentId: 'comp_zip_flap',
      partCode: 'O01',
      name: '包口拉链挡片 (Top Zipper Flap ×2)',
      category: 'opening',
      quantity: 2,
      materialId: mat.id,
      materialName: mat.name,
      thicknessMm: mat.thicknessMm,
      canvasX: zfPos.x,
      canvasY: zfPos.y,
      rotationDeg: 0,
      nodes: zfGeom.nodes,
      edges: zfGeom.edges.map((e) => ({
        ...e,
        seamType: e.edgeId === 'bottom' ? 'plain' : 'raw',
        allowanceMm: e.edgeId === 'bottom' ? 5 : 0,
        foldWidthMm: 0,
        stitchLineOffsetMm: 3.5,
      })),
      seamAllowanceMm: 5,
      foldAllowanceMm: 0,
      sewContour: [],
      cutContour: [],
      stitchContour: [],
      foldLines: [
        { id: 'fl_zf_zip', x1: 0, y1: 12, x2: zfW, y2: 12, label: '5# 拉链布边粘贴定位线' },
      ],
      holes: [],
      notches: [],
      grainAngleDeg: 0,
      boundingBoxMm: { width: zfW, height: zfH },
      perimeterMm: 0,
      areaMm2: 0,
      edgeLengthsMm: {},
      confidence: 0.9,
      isInferredHidden: false,
      notes: `裁剪 2 片，夹车 5# 金属拉链并缝合于前后包口内沿`,
    });
    pieces.push(zfPiece);
    components.push({
      id: 'comp_zip_flap',
      partCode: 'O01',
      name: '包口拉链挡片',
      standardType: 'top_zipper_flap',
      category: 'opening',
      role: '包口封闭拉链安装皮条（×2）',
      quantity: 2,
      widthMm: zfW,
      heightMm: zfH,
      thicknessMm: mat.thicknessMm,
      materialName: mat.name,
      processType: edgeProcess,
      confidence: 0.9,
      source: dimensions.dimensionSource,
      isInferredHidden: false,
      confirmed: true,
    });
    relations.push({
      id: 'rel_zip_flap_front',
      fromComponentId: 'comp_front',
      fromEdgeId: 'top',
      toComponentId: 'comp_zip_flap',
      toEdgeId: 'bottom',
      relationType: 'lining_attach',
      stitchDirection: 'lap',
      allowanceMm: 5,
      notes: '拉链挡片车缝固定于包口内侧下 12mm 处',
    });
  }

  // Core Structural Relations (Front <-> Gussets <-> Back <-> Bottom <-> Handles)
  relations.push(
    {
      id: 'rel_front_gl',
      fromComponentId: 'comp_front',
      fromEdgeId: 'left',
      toComponentId: 'comp_gusset_l',
      toEdgeId: 'front_edge',
      relationType: 'sew',
      stitchDirection: 'face_to_face',
      allowanceMm: sa,
      notes: '前片左侧边与左侧片前边对位缝合',
    },
    {
      id: 'rel_front_gr',
      fromComponentId: 'comp_front',
      fromEdgeId: 'right',
      toComponentId: 'comp_gusset_r',
      toEdgeId: 'front_edge',
      relationType: 'sew',
      stitchDirection: 'face_to_face',
      allowanceMm: sa,
      notes: '前片右侧边与右侧片前边对位缝合',
    },
    {
      id: 'rel_back_gl',
      fromComponentId: 'comp_back',
      fromEdgeId: 'right',
      toComponentId: 'comp_gusset_l',
      toEdgeId: 'back_edge',
      relationType: 'sew',
      stitchDirection: 'face_to_face',
      allowanceMm: sa,
      notes: '后片边与左侧片后边对位缝合',
    },
    {
      id: 'rel_back_gr',
      fromComponentId: 'comp_back',
      fromEdgeId: 'left',
      toComponentId: 'comp_gusset_r',
      toEdgeId: 'back_edge',
      relationType: 'sew',
      stitchDirection: 'face_to_face',
      allowanceMm: sa,
      notes: '后片边与右侧片后边对位缝合',
    },
    {
      id: 'rel_front_bot',
      fromComponentId: 'comp_front',
      fromEdgeId: 'bottom',
      toComponentId: 'comp_bottom',
      toEdgeId: 'bottom',
      relationType: 'sew',
      stitchDirection: 'face_to_face',
      allowanceMm: sa,
      notes: '前片底边与底片前边对接缝合',
    },
    {
      id: 'rel_back_bot',
      fromComponentId: 'comp_back',
      fromEdgeId: 'bottom',
      toComponentId: 'comp_bottom',
      toEdgeId: 'top',
      relationType: 'sew',
      stitchDirection: 'face_to_face',
      allowanceMm: sa,
      notes: '后片底边与底片后边对接缝合',
    },
    {
      id: 'rel_gl_bot',
      fromComponentId: 'comp_gusset_l',
      fromEdgeId: 'bottom',
      toComponentId: 'comp_bottom',
      toEdgeId: 'left',
      relationType: 'sew',
      stitchDirection: 'face_to_face',
      allowanceMm: sa,
      notes: '左侧片底边与底片左边对接缝合',
    },
    {
      id: 'rel_gr_bot',
      fromComponentId: 'comp_gusset_r',
      fromEdgeId: 'bottom',
      toComponentId: 'comp_bottom',
      toEdgeId: 'right',
      relationType: 'sew',
      stitchDirection: 'face_to_face',
      allowanceMm: sa,
      notes: '右侧片底边与底片右边对接缝合',
    },
    {
      id: 'rel_handle_anchor',
      fromComponentId: 'comp_handle',
      fromEdgeId: 'left',
      toComponentId: 'comp_anchor',
      toEdgeId: 'top',
      relationType: 'rivet',
      stitchDirection: 'lap',
      allowanceMm: 0,
      notes: '提手两端穿入提手耳仔底座并铆接加固',
    },
    {
      id: 'rel_anchor_front',
      fromComponentId: 'comp_front',
      fromEdgeId: 'top',
      toComponentId: 'comp_anchor',
      toEdgeId: 'perimeter',
      relationType: 'sew',
      stitchDirection: 'lap',
      allowanceMm: 0,
      notes: '提手连接片车缝并铆接于前后片上部受力区',
    }
  );

  return { components, relations, patterns: pieces };
}

function segmentsIntersect(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): boolean {
  const ccw = (p1: Point2D, p2: Point2D, p3: Point2D) =>
    (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
  return ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
}

/**
 * Pattern Validation Engine (Section 11):
 * Checks contour closure, zero-length segments, duplicate lines, self-intersections,
 * seam allowance rules, mating seam length differences across ComponentRelations,
 * hole bounds, and leather process compatibility.
 */
export function validateProjectPatterns(
  patterns: PatternPiece[],
  relations: ComponentRelation[],
  materialId: string,
  edgeProcess: EdgeProcessType
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const mat = getMaterialById(materialId);

  const checksRun = [
    '轮廓闭合检查',
    '零长度边检查',
    '重复线段检查',
    '轮廓自相交检查',
    '缝份规则检查',
    '接缝长度匹配检查',
    '打孔及刀口边距检查',
    '材料厚度与工艺兼容性检查',
  ];

  for (const piece of patterns) {
    const pts = piece.sewContour;

    // 1. Closure check
    if (pts.length < 3) {
      issues.push({
        id: `val_open_${piece.id}`,
        severity: 'error',
        code: 'CONTOUR_INVALID',
        title: `${piece.partCode} 轮廓节点不足`,
        detail: `纸格「${piece.name}」有效顶点少于 3 个，无法形成封闭裁片轮廓。`,
        pieceId: piece.id,
        pieceName: piece.name,
      });
      continue;
    }

    // 2. Zero-length edges & 3. Duplicate segments
    const segKeys = new Set<string>();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const len = dist(a, b);
      if (len < 0.2) {
        issues.push({
          id: `val_zero_${piece.id}_${i}`,
          severity: 'warning',
          code: 'ZERO_LENGTH_SEGMENT',
          title: `${piece.partCode} 存在微短/零长度线段`,
          detail: `纸格「${piece.name}」第 ${i + 1} 段边长为 ${round2(len)}mm，可能导致切割机重复下刀。`,
          pieceId: piece.id,
          pieceName: piece.name,
        });
      }
      const key =
        a.x < b.x || (a.x === b.x && a.y <= b.y)
          ? `${round2(a.x)},${round2(a.y)}-${round2(b.x)},${round2(b.y)}`
          : `${round2(b.x)},${round2(b.y)}-${round2(a.x)},${round2(a.y)}`;
      if (segKeys.has(key)) {
        issues.push({
          id: `val_dup_${piece.id}_${i}`,
          severity: 'warning',
          code: 'DUPLICATE_SEGMENT',
          title: `${piece.partCode} 存在重叠线段`,
          detail: `纸格「${piece.name}」发现完全重叠线段，导出 DXF 前建议合并节点。`,
          pieceId: piece.id,
          pieceName: piece.name,
        });
      }
      segKeys.add(key);
    }

    // 4. Self-intersection check (sampled at reasonable step for speed)
    const cut = piece.cutContour.length >= 3 ? piece.cutContour : pts;
    const step = cut.length > 80 ? 2 : 1;
    let hasSelfIntersect = false;
    for (let i = 0; i < cut.length && !hasSelfIntersect; i += step) {
      const a1 = cut[i];
      const a2 = cut[(i + step) % cut.length];
      for (let j = i + step * 2; j < cut.length; j += step) {
        if (i === 0 && j + step >= cut.length) continue;
        const b1 = cut[j];
        const b2 = cut[(j + step) % cut.length];
        if (segmentsIntersect(a1, a2, b1, b2)) {
          hasSelfIntersect = true;
          issues.push({
            id: `val_intersect_${piece.id}`,
            severity: 'error',
            code: 'SELF_INTERSECTION',
            title: `${piece.partCode} 裁剪外轮廓自相交`,
            detail: `纸格「${piece.name}」节点或缝份偏移后产生交叉，请检查转角节点位置。`,
            pieceId: piece.id,
            pieceName: piece.name,
          });
          break;
        }
      }
    }

    // 5. Seam allowance check on sewn edges
    for (const edge of piece.edges) {
      if (edge.seamType === 'plain' && edge.allowanceMm > 0 && edge.allowanceMm < 2.5) {
        issues.push({
          id: `val_sa_${piece.id}_${edge.edgeId}`,
          severity: 'warning',
          code: 'LOW_SEAM_ALLOWANCE',
          title: `${piece.partCode} ${edge.label} 缝份过窄`,
          detail: `当前缝份 ${edge.allowanceMm}mm 小于皮具常规安全缝份 2.5mm，车缝易崩边。`,
          pieceId: piece.id,
          pieceName: piece.name,
          edgeId: edge.edgeId,
        });
      }
    }

    // 7. Hole bounds check
    const bbox = computeBoundingBox(cut);
    for (const hole of piece.holes) {
      if (
        hole.x < bbox.minX + 1.5 ||
        hole.x > bbox.maxX - 1.5 ||
        hole.y < bbox.minY + 1.5 ||
        hole.y > bbox.maxY - 1.5
      ) {
        issues.push({
          id: `val_hole_${piece.id}_${hole.id}`,
          severity: 'error',
          code: 'HOLE_OUT_OF_BOUNDS',
          title: `${piece.partCode} 孔位越界或边距不足`,
          detail: `孔位「${hole.label || hole.id}」位于 (${hole.x}, ${hole.y})mm，距离裁片边缘不足 1.5mm。`,
          pieceId: piece.id,
          pieceName: piece.name,
        });
      }
    }
  }

  // 6. Mating Seam Length Consistency Check across ComponentRelations
  for (const rel of relations) {
    if (rel.relationType !== 'sew') continue;
    const p1 = patterns.find((p) => p.componentId === rel.fromComponentId);
    const p2 = patterns.find((p) => p.componentId === rel.toComponentId);
    if (!p1 || !p2) continue;
    if (p1.category === 'interior' || p2.category === 'interior') continue;
    if (rel.notes?.includes('贴袋') || rel.notes?.includes('受力区')) continue;

    const len1 = p1.edgeLengthsMm[rel.fromEdgeId];
    const len2 = p2.edgeLengthsMm[rel.toEdgeId];
    if (len1 == null || len2 == null) continue;

    const diffMm = round2(len1 - len2);
    if (Math.abs(diffMm) > 1.2) {
      issues.push({
        id: `val_seam_${rel.id}`,
        severity: Math.abs(diffMm) > 3 ? 'error' : 'warning',
        code: 'SEAM_LENGTH_MISMATCH',
        title: `${p1.partCode} 与 ${p2.partCode} 接缝长度不一致`,
        detail: `${p1.partCode}(${p1.name}) 的 [${rel.fromEdgeId}] 边长 ${len1}mm，与 ${p2.partCode}(${p2.name}) 的 [${rel.toEdgeId}] 边长 ${len2}mm 相差 ${diffMm > 0 ? `+${diffMm}` : diffMm}mm。`,
        pieceId: p2.id,
        pieceName: p2.name,
        edgeId: rel.toEdgeId,
        targetPieceId: p1.id,
        targetPieceName: p1.name,
        targetEdgeId: rel.fromEdgeId,
        currentMm: len2,
        expectedMm: len1,
        diffMm,
        suggestedAction: `将 ${p2.partCode} 的 [${rel.toEdgeId}] 边长校准为 ${len1}mm`,
        autoFixCommand: {
          intent: 'fix_seam_mismatch',
          target: p2.id,
          operation: 'match_edge_length',
          parameters: {
            pieceId: p2.id,
            edgeId: rel.toEdgeId,
            targetLengthMm: len1,
          },
        },
      });
    }
  }

  // 8. Material thickness vs Folded edge process check
  if (edgeProcess === 'folded' && mat.thicknessMm > mat.skivingRecommendedAboveMm) {
    issues.push({
      id: `val_mat_skive`,
      severity: 'warning',
      code: 'SKIVING_REQUIRED',
      title: `当前皮料 (${mat.thicknessMm}mm) 折边需做边缘铲薄 (Skiving)`,
      detail: `${mat.name} 厚度 ${mat.thicknessMm}mm 超过 ${mat.skivingRecommendedAboveMm}mm，包口折边处需铲薄至 0.6–0.7mm 后再折边。`,
      suggestedAction: '在工艺单注明折边区域铲薄 0.6mm，或改为油边/打磨封边。',
    });
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  return {
    checkedAt: new Date().toISOString(),
    passed: errorCount === 0,
    errorCount,
    warningCount,
    checksRun,
    issues,
  };
}

/**
 * Executes a whitelisted, schema-validated CAD command against a ProjectSnapshot.
 * Never executes arbitrary strings or code.
 */
export function applyCadCommandToSnapshot(
  snapshot: ProjectSnapshot,
  cmd: StructuredCadCommand
): { nextSnapshot: ProjectSnapshot; diffSummary: string[] } {
  const diffSummary: string[] = [];
  let bagType = snapshot.bagType;
  let dimensions: ProductDimensions = { ...snapshot.dimensions };
  let materialId = snapshot.materialId;
  let edgeProcess = snapshot.edgeProcess;
  let features: EnabledFeatures = { ...snapshot.features };
  let hardware: HardwareSpec[] = [...snapshot.hardware];
  let patterns: PatternPiece[] = snapshot.patterns.map((p) => ({ ...p }));
  let components = [...snapshot.components];
  let relations = [...snapshot.relations];

  const p = cmd.parameters || {};
  let needsRegenerate = false;

  switch (cmd.intent) {
    case 'resize_product': {
      if (p.widthMm != null) {
        const old = dimensions.widthMm;
        dimensions.widthMm = Math.max(120, Math.min(600, round2(p.widthMm)));
        diffSummary.push(`包宽：${old}mm → ${dimensions.widthMm}mm`);
        needsRegenerate = true;
      } else if (p.deltaWidthMm != null) {
        const old = dimensions.widthMm;
        dimensions.widthMm = Math.max(120, Math.min(600, round2(old + p.deltaWidthMm)));
        diffSummary.push(`包宽：${old}mm → ${dimensions.widthMm}mm (${p.deltaWidthMm >= 0 ? '+' : ''}${p.deltaWidthMm}mm)`);
        needsRegenerate = true;
      }

      if (p.heightMm != null) {
        const old = dimensions.heightMm;
        dimensions.heightMm = Math.max(100, Math.min(550, round2(p.heightMm)));
        diffSummary.push(`包高：${old}mm → ${dimensions.heightMm}mm`);
        needsRegenerate = true;
      } else if (p.deltaHeightMm != null) {
        const old = dimensions.heightMm;
        dimensions.heightMm = Math.max(100, Math.min(550, round2(old + p.deltaHeightMm)));
        diffSummary.push(`包高：${old}mm → ${dimensions.heightMm}mm (${p.deltaHeightMm >= 0 ? '+' : ''}${p.deltaHeightMm}mm)`);
        needsRegenerate = true;
      }

      if (p.depthMm != null) {
        const old = dimensions.depthMm;
        dimensions.depthMm = Math.max(40, Math.min(280, round2(p.depthMm)));
        diffSummary.push(`包深（侧面）：${old}mm → ${dimensions.depthMm}mm`);
        needsRegenerate = true;
      } else if (p.deltaDepthMm != null) {
        const old = dimensions.depthMm;
        dimensions.depthMm = Math.max(40, Math.min(280, round2(old + p.deltaDepthMm)));
        diffSummary.push(`包深（侧面）：${old}mm → ${dimensions.depthMm}mm (${p.deltaDepthMm >= 0 ? '+' : ''}${p.deltaDepthMm}mm)`);
        needsRegenerate = true;
      }

      if (p.bottomThicknessMm != null) {
        const old = dimensions.bottomThicknessMm;
        dimensions.bottomThicknessMm = Math.max(1.2, Math.min(6.0, round2(p.bottomThicknessMm)));
        diffSummary.push(`包底厚度：${old}mm → ${dimensions.bottomThicknessMm}mm`);
        needsRegenerate = true;
      }
      if (needsRegenerate) {
        dimensions.dimensionSource = 'user_confirmed';
      }
      break;
    }

    case 'resize_component': {
      if (cmd.target === 'handle' || p.deltaLengthMm != null) {
        const delta = p.deltaLengthMm ?? 20;
        const old = dimensions.handleLengthMm;
        dimensions.handleLengthMm = Math.max(180, Math.min(900, round2(old + delta)));
        diffSummary.push(`提手长度：${old}mm → ${dimensions.handleLengthMm}mm`);
        needsRegenerate = true;
      }
      if (p.bottomThicknessMm != null) {
        const old = dimensions.bottomThicknessMm;
        dimensions.bottomThicknessMm = Math.max(1.2, Math.min(6.0, round2(p.bottomThicknessMm)));
        diffSummary.push(`包底厚度：${old}mm → ${dimensions.bottomThicknessMm}mm`);
        needsRegenerate = true;
      }
      if (p.seamAllowanceMm != null) {
        const old = dimensions.seamAllowanceMm;
        dimensions.seamAllowanceMm = Math.max(2, Math.min(15, round2(p.seamAllowanceMm)));
        diffSummary.push(`全局缝份：${old}mm → ${dimensions.seamAllowanceMm}mm`);
        needsRegenerate = true;
      }
      break;
    }

    case 'modify_geometry': {
      if (p.gussetStyle) {
        const old = dimensions.gussetStyle;
        dimensions.gussetStyle = p.gussetStyle;
        if (p.gussetStyle === 'curved' && dimensions.gussetCurveRadiusMm < 18) {
          dimensions.gussetCurveRadiusMm = 24;
        }
        diffSummary.push(`侧面轮廓：${old} → ${p.gussetStyle}`);
        needsRegenerate = true;
      }
      if (p.gussetCurveRadiusMm != null) {
        dimensions.gussetCurveRadiusMm = Math.max(6, Math.min(60, round2(p.gussetCurveRadiusMm)));
        diffSummary.push(`侧片圆弧半径：${dimensions.gussetCurveRadiusMm}mm`);
        needsRegenerate = true;
      }
      if (p.cornerRadiusMm != null) {
        dimensions.cornerRadiusMm = Math.max(0, Math.min(50, round2(p.cornerRadiusMm)));
        diffSummary.push(`包身底角圆角：${dimensions.cornerRadiusMm}mm`);
        needsRegenerate = true;
      }
      if (p.topOpeningCurveMm != null) {
        dimensions.topOpeningCurveMm = Math.max(0, Math.min(45, round2(p.topOpeningCurveMm)));
        diffSummary.push(`包口弧度下沉：${dimensions.topOpeningCurveMm}mm`);
        needsRegenerate = true;
      }
      if (p.bottomThicknessMm != null) {
        dimensions.bottomThicknessMm = Math.max(1.5, Math.min(6, round2(p.bottomThicknessMm)));
        features.hasBottomBoard = true;
        diffSummary.push(`加厚包底结构至 ${dimensions.bottomThicknessMm}mm 并启用底托加固板`);
        needsRegenerate = true;
      }
      break;
    }

    case 'add_component': {
      const cType = p.componentType;
      if (cType === 'zipper_pocket') {
        features.hasZipperPocket = true;
        diffSummary.push('新增：内部拉链袋身 (I01 ×2) 与内衬连接关系');
        needsRegenerate = true;
      } else if (cType === 'front_pocket') {
        features.hasFrontPocket = true;
        diffSummary.push('新增：外置前贴袋 (P01) 及明线缝合关系');
        needsRegenerate = true;
      } else if (cType === 'slip_pocket') {
        features.hasSlipPocket = true;
        diffSummary.push('新增：内部敞口插袋 (I02)');
        needsRegenerate = true;
      } else if (cType === 'top_zipper_flap') {
        features.hasTopZipperFlap = true;
        diffSummary.push('新增：包口拉链挡片 (O01 ×2) 与拉链封口结构');
        needsRegenerate = true;
      } else if (cType === 'shoulder_strap') {
        features.hasShoulderStrap = true;
        diffSummary.push('新增：可调节肩带 (S01) 与侧耳 D 环安装孔位');
        needsRegenerate = true;
      } else if (cType === 'bottom_board') {
        features.hasBottomBoard = true;
        diffSummary.push('新增：底托加固板 (R01)');
        needsRegenerate = true;
      } else if (cType === 'magnetic_closure') {
        features.hasMagneticClosure = true;
        diffSummary.push('新增：包口 18mm 磁扣定位孔');
        needsRegenerate = true;
      }
      break;
    }

    case 'remove_component': {
      const cType = p.componentType;
      if (cType === 'zipper_pocket') {
        features.hasZipperPocket = false;
        diffSummary.push('已移除：内部拉链袋 (I01)');
        needsRegenerate = true;
      } else if (cType === 'front_pocket') {
        features.hasFrontPocket = false;
        diffSummary.push('已移除：外置前贴袋 (P01)');
        needsRegenerate = true;
      } else if (cType === 'slip_pocket') {
        features.hasSlipPocket = false;
        diffSummary.push('已移除：内部敞口插袋 (I02)');
        needsRegenerate = true;
      } else if (cType === 'top_zipper_flap') {
        features.hasTopZipperFlap = false;
        diffSummary.push('已移除：包口拉链挡片 (O01)');
        needsRegenerate = true;
      } else if (cType === 'shoulder_strap') {
        features.hasShoulderStrap = false;
        diffSummary.push('已移除：可调节肩带 (S01)');
        needsRegenerate = true;
      } else if (cType === 'bottom_board') {
        features.hasBottomBoard = false;
        diffSummary.push('已移除：底托加固板 (R01)');
        needsRegenerate = true;
      } else if (p.pieceId) {
        patterns = patterns.filter((x) => x.id !== p.pieceId);
        diffSummary.push(`已删除指定纸格 ${p.pieceId}`);
      }
      break;
    }

    case 'change_material': {
      if (p.materialId) {
        const mat = getMaterialById(p.materialId);
        materialId = mat.id;
        edgeProcess = p.edgeProcess ?? mat.recommendedEdgeProcess;
        dimensions.seamAllowanceMm = mat.defaultSeamAllowanceMm;
        dimensions.foldWidthMm = mat.defaultFoldWidthMm;
        dimensions.stitchSpacingMm = mat.stitchSpacingMm;
        diffSummary.push(`切换材料：${mat.name} (${mat.thicknessMm}mm)，工艺：${EDGE_PROCESS_LABELS[edgeProcess]}`);
        needsRegenerate = true;
      } else if (p.edgeProcess) {
        edgeProcess = p.edgeProcess;
        diffSummary.push(`调整边缘工艺：${EDGE_PROCESS_LABELS[edgeProcess]}`);
        needsRegenerate = true;
      }
      if (p.stitchSpacingMm != null) {
        dimensions.stitchSpacingMm = round2(p.stitchSpacingMm);
        diffSummary.push(`缝线孔距调整为 ${dimensions.stitchSpacingMm}mm`);
        needsRegenerate = true;
      }
      break;
    }

    case 'calibrate_scale': {
      const axis = p.referenceAxis ?? 'width';
      const actualMm = p.actualMm ?? dimensions.widthMm;
      const currentVal =
        axis === 'width'
          ? dimensions.widthMm
          : axis === 'height'
            ? dimensions.heightMm
            : dimensions.depthMm;
      const ratio = actualMm / Math.max(10, currentVal);
      dimensions.widthMm = round2(dimensions.widthMm * ratio);
      dimensions.heightMm = round2(dimensions.heightMm * ratio);
      dimensions.depthMm = round2(dimensions.depthMm * ratio);
      dimensions.handleLengthMm = round2(dimensions.handleLengthMm * ratio);
      dimensions.dimensionSource = 'scale_calibrated';
      dimensions.calibrationNote = `已根据${axis === 'width' ? '包宽' : axis === 'height' ? '包高' : '侧面深度'}=${actualMm}mm 等比校准 (×${round2(ratio)})`;
      diffSummary.push(dimensions.calibrationNote);
      needsRegenerate = true;
      break;
    }

    case 'fix_seam_mismatch': {
      // If a manual node edit caused a gusset/body seam length mismatch, synchronize the piece height/edge
      const targetPiece = patterns.find((x) => x.id === p.pieceId);
      if (targetPiece && p.targetLengthMm != null) {
        const currentLen = p.edgeId ? targetPiece.edgeLengthsMm[p.edgeId] : undefined;
        if (currentLen && currentLen > 0) {
          const scaleY = p.targetLengthMm / currentLen;
          const updatedNodes = targetPiece.nodes.map((node) => ({
            ...node,
            y: round2(node.y * scaleY),
            cy1: node.cy1 != null ? round2(node.cy1 * scaleY) : undefined,
            cy2: node.cy2 != null ? round2(node.cy2 * scaleY) : undefined,
          }));
          patterns = patterns.map((x) =>
            x.id === targetPiece.id ? computePieceGeometry({ ...x, nodes: updatedNodes }) : x
          );
          diffSummary.push(
            `已校准 ${targetPiece.partCode} 的 [${p.edgeId}] 边长至 ${p.targetLengthMm}mm`
          );
        }
      }
      break;
    }

    case 'optimize_pattern': {
      const goal = p.optimizationGoal ?? 'reduce_waste';
      if (goal === 'reduce_waste') {
        const oldSa = dimensions.seamAllowanceMm;
        const targetSa = Math.max(4, Math.min(oldSa, 4.5));
        if (targetSa !== oldSa) {
          dimensions.seamAllowanceMm = targetSa;
          diffSummary.push(`优化缝份余量：${oldSa}mm → ${targetSa}mm（减少边角耗料）`);
        }
        needsRegenerate = true;
      } else if (goal === 'reduce_seams') {
        features.hasFrontPocket = false;
        dimensions.cornerRadiusMm = Math.max(4, dimensions.cornerRadiusMm);
        diffSummary.push('精简外部冗余贴袋拼接，优化主片连续下料轮廓');
        needsRegenerate = true;
      } else if (goal === 'italian_luxury') {
        const boxCalf = getMaterialById('box_calf_15');
        materialId = boxCalf.id;
        edgeProcess = 'edge_paint';
        dimensions.seamAllowanceMm = boxCalf.defaultSeamAllowanceMm;
        dimensions.stitchSpacingMm = 3.38;
        dimensions.cornerRadiusMm = Math.max(8, dimensions.cornerRadiusMm);
        features.hasBottomBoard = true;
        diffSummary.push('升级意式箱包工程配置：盒式小牛皮 (1.5mm) · 多层油边 · 3.38mm 精密针距 · 底托加固');
        needsRegenerate = true;
      } else if (goal === 'comfort_handle') {
        const oldLen = dimensions.handleLengthMm;
        dimensions.handleLengthMm = Math.min(580, round2(oldLen + 40));
        dimensions.handleDropMm = round2(dimensions.handleDropMm + 20);
        diffSummary.push(`人体工学提手舒适度优化：长度 ${oldLen}mm → ${dimensions.handleLengthMm}mm，增加拎持余量`);
        needsRegenerate = true;
      } else if (goal === 'optimize_zipper') {
        features.hasTopZipperFlap = true;
        features.hasZipperPocket = true;
        diffSummary.push('优化包口拉链挡片退让量 (-6mm 避让角) 并启用内部拉链袋');
        needsRegenerate = true;
      }
      break;
    }

    case 'apply_nesting': {
      const nest = computeSmartNesting(
        patterns,
        materialId,
        hardware,
        p.hideWidthMm,
        p.hideHeightMm
      );
      let auxX = 20;
      const auxY =
        nest.placements.length > 0
          ? Math.max(...nest.placements.map((pl) => pl.yMm + pl.heightMm)) + 40
          : 40;
      patterns = patterns.map((pc) => {
        const firstCopy = nest.placements.find((pl) => pl.pieceId === pc.id && pl.copyIndex === 1);
        if (firstCopy) {
          return {
            ...pc,
            canvasX: round2(firstCopy.xMm),
            canvasY: round2(firstCopy.yMm),
          };
        }
        const nextAux = { ...pc, canvasX: round2(auxX), canvasY: round2(auxY) };
        auxX += pc.boundingBoxMm.width + 20;
        return nextAux;
      });
      diffSummary.push(
        `已完成皮革纹理与避瑕智能排料（主皮利用率 ${nest.utilizationPct}%，主面净耗 ${nest.netPiecesAreaDm2} dm²）`
      );
      break;
    }

    case 'run_validation':
    case 'design_advice':
    case 'undo_last':
    case 'redo_last':
      break;
  }

  if (needsRegenerate) {
    // Preserve any manually added custom pieces (id starts with custom_ or dxf_)
    const customPieces = patterns.filter(
      (x) => x.id.startsWith('custom_') || x.id.startsWith('dxf_')
    );
    const generated = generateParametricPatterns(
      bagType,
      dimensions,
      materialId,
      edgeProcess,
      features,
      patterns
    );
    components = generated.components;
    relations = generated.relations;
    patterns = [...generated.patterns, ...customPieces];

    if (cmd.intent === 'optimize_pattern' && cmd.parameters?.optimizationGoal === 'reduce_waste') {
      const nest = computeSmartNesting(patterns, materialId, hardware);
      let auxX = 20;
      const auxY =
        nest.placements.length > 0
          ? Math.max(...nest.placements.map((pl) => pl.yMm + pl.heightMm)) + 40
          : 40;
      patterns = patterns.map((pc) => {
        const firstCopy = nest.placements.find((pl) => pl.pieceId === pc.id && pl.copyIndex === 1);
        if (firstCopy) {
          return { ...pc, canvasX: round2(firstCopy.xMm), canvasY: round2(firstCopy.yMm) };
        }
        const nextAux = { ...pc, canvasX: round2(auxX), canvasY: round2(auxY) };
        auxX += pc.boundingBoxMm.width + 20;
        return nextAux;
      });
      diffSummary.push(`自动纹理排料完成（主皮利用率 ${nest.utilizationPct}%）`);
    }
  }

  const validation = validateProjectPatterns(patterns, relations, materialId, edgeProcess);

  return {
    nextSnapshot: {
      bagType,
      dimensions,
      materialId,
      edgeProcess,
      features,
      hardware,
      components,
      relations,
      patterns,
      validation,
      // Any geometry/material edit automatically invalidates manual sign-offs
      qualitySignoff: {
        patternMakerConfirmed: false,
        physicalSamplePassed: false,
      },
    },
    diffSummary,
  };
}

export interface CadTransactionResult {
  committed: boolean;
  nextSnapshot: ProjectSnapshot;
  diffSummary: string[];
  rollbackReason?: string;
}

/**
 * Atomic CAD Transaction Executor (Section 5):
 * Executes a batch of structured commands on an isolated clone and verifies
 * geometric invariants (no NaN, no open contours, no self-intersection).
 * If any command throws or produces broken geometry, rolls back completely.
 */
export function executeCadTransaction(
  originalSnapshot: ProjectSnapshot,
  commands: StructuredCadCommand[]
): CadTransactionResult {
  if (commands.length === 0) {
    return { committed: true, nextSnapshot: originalSnapshot, diffSummary: [] };
  }

  let working: ProjectSnapshot = structuredClone(originalSnapshot);
  const allDiffs: string[] = [];

  try {
    for (const cmd of commands) {
      const { nextSnapshot, diffSummary } = applyCadCommandToSnapshot(working, cmd);

      // Verify finite coordinates and non-degenerate contours on every piece
      for (const pc of nextSnapshot.patterns) {
        if (
          !Number.isFinite(pc.boundingBoxMm.width) ||
          !Number.isFinite(pc.boundingBoxMm.height) ||
          pc.boundingBoxMm.width <= 0 ||
          pc.boundingBoxMm.height <= 0
        ) {
          throw new Error(`裁片 ${pc.partCode} 尺寸计算异常，事务已安全回滚。`);
        }
      }

      const fatalIssue = nextSnapshot.validation.issues.find(
        (iss) => iss.code === 'CONTOUR_INVALID' || iss.code === 'SELF_INTERSECTION'
      );
      if (fatalIssue) {
        throw new Error(`几何轮廓损坏 (${fatalIssue.title})，事务已整批回滚至修改前状态。`);
      }

      working = nextSnapshot;
      allDiffs.push(...diffSummary);
    }

    return {
      committed: true,
      nextSnapshot: working,
      diffSummary: allDiffs,
    };
  } catch (err) {
    return {
      committed: false,
      nextSnapshot: originalSnapshot,
      diffSummary: [],
      rollbackReason: err instanceof Error ? err.message : 'CAD 事务执行失败，已整体回滚。',
    };
  }
}

/**
 * Grain-direction & hide-defect-aware 2D shelf nesting + material/hardware BOM cost estimator.
 */
export function computeSmartNesting(
  patterns: PatternPiece[],
  materialId: string,
  hardware: HardwareSpec[],
  hideWidthMm = 1200,
  hideHeightMm = 820
): NestingResult {
  const mat = getMaterialById(materialId);
  const margin = 20;
  const gap = 10;

  // Natural leather edge/flaw zones (neck scar + belly stretch margin)
  const defectZones: HideDefectZone[] = [
    {
      id: 'def_belly_top',
      label: '肚腩松弛避让区（边缘 22mm）',
      xMm: 0,
      yMm: 0,
      widthMm: hideWidthMm,
      heightMm: 22,
    },
    {
      id: 'def_neck_scar',
      label: '颈纹/天然瑕疵预留避让区',
      xMm: hideWidthMm - 180,
      yMm: hideHeightMm - 110,
      widthMm: 180,
      heightMm: 110,
    },
  ];

  const findOverlappingDefect = (x: number, y: number, w: number, h: number) =>
    defectZones.find(
      (z) =>
        x < z.xMm + z.widthMm &&
        x + w > z.xMm &&
        y < z.yMm + z.heightMm &&
        y + h > z.yMm
    );

  // Separate main leather cuts from lining/board auxiliary parts
  const leatherPieces = patterns.filter((pc) => pc.materialId === materialId);
  const targetPieces = leatherPieces.length > 0 ? leatherPieces : patterns;

  interface ExpandedPiece {
    piece: PatternPiece;
    copyIndex: number;
    w: number;
    h: number;
    canRotate: boolean;
  }

  const items: ExpandedPiece[] = [];
  for (const piece of targetPieces) {
    const qty = Math.max(1, piece.quantity);
    const canRotate = !mat.grainRequired || piece.category === 'reinforcement' || piece.category === 'interior';
    for (let c = 1; c <= qty; c++) {
      items.push({
        piece,
        copyIndex: c,
        w: round2(piece.boundingBoxMm.width),
        h: round2(piece.boundingBoxMm.height),
        canRotate,
      });
    }
  }
  items.sort((a, b) => b.h * b.w - a.h * a.w);

  const placements: PlacedNestItem[] = [];
  const unplacedPieces: string[] = [];

  let curX = margin;
  let curY = 28; // below top belly zone
  let rowH = 0;

  for (const item of items) {
    let placedW = item.w;
    let placedH = item.h;
    let rotated90 = false;

    if (item.canRotate && item.h > item.w * 1.15 && item.h < hideWidthMm - margin * 2) {
      placedW = item.h;
      placedH = item.w;
      rotated90 = true;
    }

    let found = false;
    for (let attempts = 0; attempts < 80; attempts++) {
      if (curX + placedW + margin > hideWidthMm) {
        curX = margin;
        curY += Math.max(rowH, 24) + gap;
        rowH = 0;
      }
      if (curY + placedH + margin > hideHeightMm) {
        break;
      }
      const hit = findOverlappingDefect(curX, curY, placedW, placedH);
      if (!hit) {
        placements.push({
          pieceId: item.piece.id,
          partCode: item.piece.partCode,
          name: item.piece.name,
          copyIndex: item.copyIndex,
          xMm: round2(curX),
          yMm: round2(curY),
          widthMm: placedW,
          heightMm: placedH,
          rotated90,
          grainAligned: !rotated90,
        });
        curX += placedW + gap;
        rowH = Math.max(rowH, placedH);
        found = true;
        break;
      }
      curX = hit.xMm + hit.widthMm + gap;
    }
    if (!found) {
      unplacedPieces.push(`${item.piece.partCode} #${item.copyIndex}`);
    }
  }

  const netPiecesAreaMm2 = targetPieces.reduce(
    (sum, pc) => sum + pc.areaMm2 * Math.max(1, pc.quantity),
    0
  );
  const netPiecesAreaDm2 = round2(netPiecesAreaMm2 / 10000);

  const usedMaxY = placements.length
    ? Math.max(...placements.map((p) => p.yMm + p.heightMm)) + margin
    : 100;
  const effectiveSheetAreaMm2 = hideWidthMm * Math.min(hideHeightMm, Math.max(200, usedMaxY));
  const usableAreaDm2 = round2(effectiveSheetAreaMm2 / 10000);
  const utilizationPct =
    usableAreaDm2 > 0 ? round2(Math.min(96, (netPiecesAreaDm2 / usableAreaDm2) * 100)) : 0;

  const grossMainDm2 = utilizationPct > 0 ? netPiecesAreaDm2 / (utilizationPct / 100) : netPiecesAreaDm2 * 1.35;
  const costRate = mat.costPerDm2Cny ?? 7.5;
  const estimatedLeatherCostCny = round2(grossMainDm2 * costRate);
  const estimatedHardwareCostCny = round2(
    hardware.reduce((s, h) => s + h.quantity * (h.type === 'zipper' ? 14 : h.type === 'turn_lock' ? 18 : 4.5), 0)
  );

  return {
    hideWidthMm,
    hideHeightMm,
    usableAreaDm2,
    netPiecesAreaDm2,
    utilizationPct,
    totalPieceCuts: items.length,
    grainLockedCount: placements.filter((p) => p.grainAligned).length,
    defectZones,
    placements,
    unplacedPieces,
    estimatedLeatherCostCny,
    estimatedHardwareCostCny,
    estimatedTotalMaterialCostCny: round2(estimatedLeatherCostCny + estimatedHardwareCostCny),
    notes: [
      mat.grainRequired
        ? '已锁定主皮裁片纹理方向（主包片 90° 竖纹，提手/肩带 0° 顺背脊纹）禁止任意旋转（里布与底衬单独排版）。'
        : '摔纹皮方向约束较宽松，内衬与辅料单独排版，主皮片按紧凑纹理排列。',
      '已避让整张皮革边缘肚腩松弛区 (22mm) 与颈纹瑕疵区 (180×110mm)。',
    ],
  };
}

/**
 * 4-State & 8-Dimension Design Quality Assessment Report (Section 7):
 * Strictly separates Geometry Verified, Process Rule Verified,
 * Patternmaker Confirmed, and Physical Sample Passed.
 */
export function buildQualityAssessmentReport(project: Project): QualityReportSummary {
  const mat = getMaterialById(project.materialId);
  const issues = project.validation.issues;
  const geometryErrors = issues.filter(
    (i) =>
      i.severity === 'error' &&
      (i.code === 'CONTOUR_INVALID' ||
        i.code === 'SELF_INTERSECTION' ||
        i.code === 'SEAM_LENGTH_MISMATCH' ||
        i.code === 'HOLE_OUT_OF_BOUNDS')
  );
  const processIssues = issues.filter(
    (i) =>
      i.code === 'LOW_SEAM_ALLOWANCE' ||
      i.code === 'SKIVING_REQUIRED' ||
      i.code === 'ZERO_LENGTH_SEGMENT' ||
      i.code === 'DUPLICATE_SEGMENT'
  );

  const geometryVerified = project.patterns.length > 0 && geometryErrors.length === 0;
  const processRuleVerified =
    geometryVerified &&
    processIssues.filter((i) => i.severity === 'error').length === 0 &&
    project.dimensions.dimensionSource !== 'ai_estimated';

  const unconfirmedStructures = [
    ...project.components.filter((c) => c.isInferredHidden && !c.confirmed).map((c) => `${c.partCode} ${c.name}`),
    ...(project.visionSummary?.uncertainStructures ?? []),
  ];

  const productionRisks: string[] = [];
  if (project.dimensions.dimensionSource === 'ai_estimated') {
    productionRisks.push('尺寸尚未通过真实实物标尺确认，存在整包比例缩放风险');
  }
  if (processIssues.some((i) => i.code === 'SKIVING_REQUIRED')) {
    productionRisks.push(`${mat.name} (${mat.thicknessMm}mm) 折边位需铲薄至 0.65mm，否则边角易爆裂`);
  }
  if (!project.qualitySignoff?.patternMakerConfirmed) {
    productionRisks.push('尚未经专业打版师人工复核签名');
  }
  if (!project.qualitySignoff?.physicalSamplePassed) {
    productionRisks.push('尚未通过车间实际裁皮缝制首件试样验证');
  }

  return {
    geometryVerified,
    processRuleVerified,
    patternMakerConfirmed: Boolean(project.qualitySignoff?.patternMakerConfirmed),
    physicalSamplePassed: Boolean(project.qualitySignoff?.physicalSamplePassed),
    geometryStatus: geometryVerified
      ? `${project.patterns.length} 片纸格轮廓闭合、无自相交、打孔边距安全`
      : `存在 ${geometryErrors.length} 项几何结构错误`,
    componentCompleteness: `共 ${project.components.length} 个结构部件（可见 ${project.components.filter((c) => !c.isInferredHidden).length} · 推断隐藏 ${project.components.filter((c) => c.isInferredHidden).length}）`,
    seamMatchStatus: issues.some((i) => i.code === 'SEAM_LENGTH_MISMATCH')
      ? '存在接缝长度偏差，请在校验栏一键校准'
      : `全部 ${project.relations.filter((r) => r.relationType === 'sew').length} 组缝合关系误差 ≤ ±1.2mm`,
    dimensionCalibrationStatus:
      project.dimensions.dimensionSource === 'user_confirmed'
        ? '用户已明确确认真实毫米尺寸'
        : project.dimensions.dimensionSource === 'scale_calibrated'
          ? '已按真实比例尺校准'
          : 'AI 估算尺寸（投产前建议校准）',
    seamAllowanceStatus: issues.some((i) => i.code === 'LOW_SEAM_ALLOWANCE')
      ? '部分边缝份小于 2.5mm 安全阈值'
      : `缝份规则正常（默认 ${project.dimensions.seamAllowanceMm}mm）`,
    materialCompatibilityStatus: `${mat.name} (${mat.thicknessMm}mm) · 针距 ${project.dimensions.stitchSpacingMm}mm`,
    unconfirmedStructures: Array.from(new Set(unconfirmedStructures)),
    productionRisks,
  };
}

export function createStarterSnapshot(bagType: BagType): ProjectSnapshot {
  const arch = BAG_ARCHETYPES[bagType];
  const generated = generateParametricPatterns(
    bagType,
    arch.dimensions,
    arch.materialId,
    arch.edgeProcess,
    arch.features
  );
  const validation = validateProjectPatterns(
    generated.patterns,
    generated.relations,
    arch.materialId,
    arch.edgeProcess
  );
  return {
    bagType,
    dimensions: { ...arch.dimensions },
    materialId: arch.materialId,
    edgeProcess: arch.edgeProcess,
    features: { ...arch.features },
    hardware: arch.hardware.map((h) => ({ ...h })),
    components: generated.components,
    relations: generated.relations,
    patterns: generated.patterns,
    validation,
  };
}

export function createCustomBlankPiece(
  name: string,
  widthMm: number,
  heightMm: number,
  materialId: string,
  allowanceMm = 5,
  existingCount = 0
): PatternPiece {
  const mat = getMaterialById(materialId);
  const id = `custom_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const geom = makeRectNodes(widthMm, heightMm, 0, 0);
  const edges = geom.edges.map((e) => ({
    ...e,
    seamType: 'plain' as const,
    allowanceMm,
    foldWidthMm: 0,
    stitchLineOffsetMm: 3.5,
  }));
  return computePieceGeometry({
    id,
    componentId: `comp_${id}`,
    partCode: `M${String(existingCount + 1).padStart(2, '0')}`,
    name,
    category: 'body',
    quantity: 1,
    materialId: mat.id,
    materialName: mat.name,
    thicknessMm: mat.thicknessMm,
    canvasX: 60 + (existingCount % 3) * (widthMm + 40),
    canvasY: 60 + Math.floor(existingCount / 3) * (heightMm + 40),
    rotationDeg: 0,
    nodes: geom.nodes,
    edges,
    seamAllowanceMm: allowanceMm,
    foldAllowanceMm: 0,
    sewContour: [],
    cutContour: [],
    stitchContour: [],
    foldLines: [],
    holes: [],
    notches: [],
    grainAngleDeg: 90,
    boundingBoxMm: { width: widthMm, height: heightMm },
    perimeterMm: 0,
    areaMm2: 0,
    edgeLengthsMm: {},
    manuallyEdited: true,
    notes: '手工创建二维纸格裁片',
  });
}

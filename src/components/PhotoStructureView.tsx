import React, { useRef, useState } from 'react';
import { Eye, EyeOff, ImagePlus } from 'lucide-react';
import type { ImageAngle, Project } from '../shared/types';

interface PhotoStructureViewProps {
  project: Project;
  onSelectPiece: (pieceId: string) => void;
  onAddPhotos: (
    images: Array<{ name: string; angle: ImageAngle; dataUrl: string; mimeType: string }>
  ) => Promise<void>;
}

const ANGLE_LABEL: Record<ImageAngle, string> = {
  front: '正面',
  back: '背面',
  side: '侧面',
  bottom: '底部',
  interior: '内部',
  detail: '细节',
};

export const PhotoStructureView: React.FC<PhotoStructureViewProps> = ({
  project,
  onSelectPiece,
  onAddPhotos,
}) => {
  const [activeImgIdx, setActiveImgIdx] = useState(0);
  const [showOverlays, setShowOverlays] = useState(true);
  const [hoveredCompId, setHoveredCompId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const activeImage = project.images[activeImgIdx] || project.images[0];
  const visibleWithBox = project.components.filter(
    (c) => !c.isInferredHidden && c.boundingBox2D && c.boundingBox2D.length === 4
  );
  const inferredHidden = project.components.filter((c) => c.isInferredHidden);

  const handleFileChange = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const loaded: Array<{
      name: string;
      angle: ImageAngle;
      dataUrl: string;
      mimeType: string;
    }> = [];
    for (const f of Array.from(files)) {
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.readAsDataURL(f);
      });
      loaded.push({
        name: f.name,
        angle: 'side',
        dataUrl,
        mimeType: f.type || 'image/jpeg',
      });
    }
    await onAddPhotos(loaded);
  };

  return (
    <div className="flex-1 bg-[#F6F5F1] overflow-y-auto p-6 min-h-0">
      <div className="max-w-[1060px] mx-auto grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left: Uploaded Reference Photo + AI Segmentation / Bounding Boxes */}
        <div className="xl:col-span-6 bg-[#FFFFFF] border border-[#E4E2DC] rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-display text-sm font-semibold text-[#141413]">
              参考照片与部件识别
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowOverlays((v) => !v)}
                className="px-2.5 py-1 text-xs border border-[#D8D5CD] rounded bg-[#FAF9F6] text-[#141413] flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                {showOverlays ? (
                  <>
                    <EyeOff className="w-3.5 h-3.5" />
                    隐藏识别框
                  </>
                ) : (
                  <>
                    <Eye className="w-3.5 h-3.5" />
                    显示识别框
                  </>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(e) => handleFileChange(e.target.files)}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="px-2.5 py-1 text-xs border border-[#D8D5CD] rounded bg-white hover:bg-[#FAF9F6] text-[#9A4D22] flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <ImagePlus className="w-3.5 h-3.5" />
                补充角度照片
              </button>
            </div>
          </div>

          {activeImage ? (
            <div className="relative w-full aspect-[4/3] bg-[#ECEAE3] rounded border border-[#E4E2DC] overflow-hidden">
              <img
                src={activeImage.dataUrl}
                alt={activeImage.name}
                referrerPolicy="no-referrer"
                className="w-full h-full object-contain"
              />
              {showOverlays &&
                visibleWithBox.map((comp) => {
                  const [ymin, xmin, ymax, xmax] = comp.boundingBox2D!;
                  const isHov = hoveredCompId === comp.id;
                  return (
                    <div
                      key={comp.id}
                      onMouseEnter={() => setHoveredCompId(comp.id)}
                      onMouseLeave={() => setHoveredCompId(null)}
                      onClick={() => {
                        const match = project.patterns.find(
                          (p) => p.componentId === comp.id
                        );
                        if (match) onSelectPiece(match.id);
                      }}
                      style={{
                        top: `${ymin / 10}%`,
                        left: `${xmin / 10}%`,
                        width: `${Math.max(4, (xmax - xmin) / 10)}%`,
                        height: `${Math.max(4, (ymax - ymin) / 10)}%`,
                      }}
                      className={`absolute border transition-colors cursor-pointer ${
                        isHov
                          ? 'border-[#9A4D22] bg-[#9A4D22]/15 z-10'
                          : 'border-[#16A34A]/80 bg-[#16A34A]/5'
                      }`}
                    >
                      <span className="inline-block px-1.5 py-0.5 text-[10px] font-mono bg-[#141413]/80 text-white whitespace-nowrap">
                        {comp.partCode} {comp.name} ({Math.round(comp.confidence * 100)}%)
                      </span>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="aspect-[4/3] border border-dashed border-[#C9C5BC] rounded flex flex-col items-center justify-center text-xs text-[#78756E]">
              尚未上传参考照片（当前为纯参数/手工模式）
            </div>
          )}

          {project.images.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto">
              {project.images.map((img, idx) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => setActiveImgIdx(idx)}
                  className={`flex items-center gap-1.5 p-1 rounded border text-xs whitespace-nowrap shrink-0 ${
                    idx === activeImgIdx
                      ? 'border-[#9A4D22] bg-[#FAF6F2]'
                      : 'border-[#E4E2DC] bg-white'
                  }`}
                >
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    referrerPolicy="no-referrer"
                    className="w-8 h-8 object-cover rounded"
                  />
                  <span>{ANGLE_LABEL[img.angle] || img.angle}</span>
                </button>
              ))}
            </div>
          )}

          {/* Vision Analysis Notes & Explicit Uncertainty */}
          {project.visionSummary && (
            <div className="pt-3 border-t border-[#ECEAE3] space-y-2.5 text-xs">
              <div>
                <span className="font-semibold text-[#141413]">AI 结构研判：</span>
                <span className="text-[#5C5B57]">{project.visionSummary.visualNotes}</span>
              </div>
              {project.visionSummary.uncertainStructures.length > 0 && (
                <div className="bg-[#FFFBEB] border border-[#F59E0B]/30 rounded p-2.5 text-[#92400E]">
                  <div className="font-semibold mb-1">
                    不可见 / 需人工确认的结构（未伪造确定性）：
                  </div>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {project.visionSummary.uncertainStructures.map((u, idx) => (
                      <li key={idx}>{u}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Component Connection Graph & Hidden Inferred List */}
        <div className="xl:col-span-6 space-y-6">
          <div className="bg-[#FFFFFF] border border-[#E4E2DC] rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold text-[#141413]">
                部件连接关系图 ({project.relations.length} 条接缝关系)
              </h3>
              <span className="text-xs text-[#78756E] font-mono tabular-nums">
                {project.components.length} 个部件
              </span>
            </div>

            <div className="border border-[#ECEAE3] rounded overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#FAF9F6] text-[#5C5B57] border-b border-[#ECEAE3]">
                  <tr>
                    <th className="py-2 px-3 font-medium">部件 A · 边</th>
                    <th className="py-2 px-3 font-medium">连接方式</th>
                    <th className="py-2 px-3 font-medium">部件 B · 边</th>
                    <th className="py-2 px-3 font-medium text-right">边长差 (mm)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ECEAE3]">
                  {project.relations.map((rel) => {
                    const c1 = project.components.find((c) => c.id === rel.fromComponentId);
                    const c2 = project.components.find((c) => c.id === rel.toComponentId);
                    const p1 = project.patterns.find(
                      (p) => p.componentId === rel.fromComponentId
                    );
                    const p2 = project.patterns.find(
                      (p) => p.componentId === rel.toComponentId
                    );
                    const l1 = p1?.edgeLengthsMm[rel.fromEdgeId];
                    const l2 = p2?.edgeLengthsMm[rel.toEdgeId];
                    const diff =
                      l1 != null && l2 != null && rel.relationType === 'sew'
                        ? Math.round((l1 - l2) * 100) / 100
                        : null;

                    return (
                      <tr key={rel.id} className="hover:bg-[#FAF9F6]">
                        <td className="py-2 px-3">
                          <span className="font-mono text-[#141413]">
                            {c1?.partCode || rel.fromComponentId}
                          </span>{' '}
                          <span className="text-[#5C5B57]">
                            {c1?.name} [{rel.fromEdgeId}]
                          </span>
                        </td>
                        <td className="py-2 px-3 text-[#5C5B57]">
                          {rel.relationType === 'sew'
                            ? `车缝 (${rel.allowanceMm}mm)`
                            : rel.relationType === 'rivet'
                              ? '撞钉铆接'
                              : rel.relationType === 'lining_attach'
                                ? '内衬贴合'
                                : rel.relationType === 'reinforce'
                                  ? '衬板加固'
                                  : '五金安装'}
                        </td>
                        <td className="py-2 px-3">
                          <span className="font-mono text-[#141413]">
                            {c2?.partCode || rel.toComponentId}
                          </span>{' '}
                          <span className="text-[#5C5B57]">
                            {c2?.name} [{rel.toEdgeId}]
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums">
                          {diff == null ? (
                            <span className="text-[#78756E]">—</span>
                          ) : Math.abs(diff) <= 1.2 ? (
                            <span className="text-[#16A34A]">0.0 mm</span>
                          ) : (
                            <span className="text-[#DC2626]">
                              {diff > 0 ? `+${diff}` : diff} mm
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Inferred Hidden Components */}
          <div className="bg-[#FFFFFF] border border-[#E4E2DC] rounded-lg p-5 space-y-3">
            <h3 className="font-display text-sm font-semibold text-[#141413]">
              隐藏与推断部件标记 ({inferredHidden.length})
            </h3>
            <p className="text-xs text-[#5C5B57]">
              以下部件无法从外部照片直接观测，由皮具结构知识库依据包型推断生成，请在打版与打样前确认：
            </p>
            <div className="divide-y divide-[#ECEAE3]">
              {inferredHidden.map((comp) => (
                <div key={comp.id} className="py-2.5 flex items-center justify-between text-xs">
                  <div>
                    <span className="font-mono font-medium text-[#141413]">
                      {comp.partCode}
                    </span>{' '}
                    <span className="font-medium text-[#141413]">{comp.name}</span>
                    <span className="text-[#78756E]"> · {comp.role}</span>
                  </div>
                  <span className="font-mono tabular-nums text-[#D97706]">
                    推断置信度 {Math.round(comp.confidence * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

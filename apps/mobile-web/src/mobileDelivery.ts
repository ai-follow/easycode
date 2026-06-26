import type { DeliveryState } from "@easycode/protocol";

export type MobileDeliveryDisplay = {
  status: DeliveryState["status"];
  summary: string;
  command?: string;
};

export const formatMobileDelivery = (
  delivery: Pick<DeliveryState, "status" | "detail" | "inputId">
): MobileDeliveryDisplay => {
  const rawDetail = (delivery.detail ?? delivery.inputId).trim();
  const command = extractRunCommand(rawDetail);
  return {
    status: delivery.status,
    summary: command ? rawDetail.slice(0, command.index).replace(/[.\s]+$/, "") : rawDetail,
    command: command?.value
  };
};

const extractRunCommand = (detail: string): { index: number; value: string } | undefined => {
  const marker = "Run:";
  const index = detail.indexOf(marker);
  if (index < 0) return undefined;
  const value = detail.slice(index + marker.length).trim();
  return value.length > 0 ? { index, value } : undefined;
};

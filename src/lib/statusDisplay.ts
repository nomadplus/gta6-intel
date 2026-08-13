import type { InvestigationStatus, DevelopmentOutcome } from "@/db/queries/claims";

type StatusDisplay = {
  label: string;
  description: string;
  tone: "neutral" | "positive" | "negative" | "pending";
};

export const investigationStatusDisplay: Record<InvestigationStatus, StatusDisplay> = {
  unverified: {
    label: "Unverified",
    description: "Single-source report, no corroboration yet.",
    tone: "pending",
  },
  corroborated: {
    label: "Corroborated",
    description: "Independently reported by more than one source.",
    tone: "pending",
  },
  strongly_corroborated: {
    label: "Strongly Corroborated",
    description: "Consistent, independent reporting across multiple sources.",
    tone: "pending",
  },
  confirmed: {
    label: "Confirmed",
    description: "Verified by official material or statement.",
    tone: "positive",
  },
  disproven: {
    label: "Disproven",
    description: "Contradicted by subsequent official material or evidence.",
    tone: "negative",
  },
  unresolvable: {
    label: "Unresolvable",
    description: "Evidence is insufficient and unlikely to improve.",
    tone: "neutral",
  },
};

export const developmentOutcomeDisplay: Record<DevelopmentOutcome, StatusDisplay> = {
  unknown: {
    label: "Unknown",
    description: "No information yet on the final development outcome.",
    tone: "neutral",
  },
  reflected_in_development: {
    label: "Reflected in Development",
    description: "Confirmed present in an internal build at the time reported.",
    tone: "pending",
  },
  changed_during_development: {
    label: "Changed During Development",
    description: "Present at one point, later altered before release.",
    tone: "pending",
  },
  cut: {
    label: "Cut",
    description: "Existed during development but removed before release.",
    tone: "negative",
  },
  in_final_game: {
    label: "In Final Game",
    description: "Present in the released game.",
    tone: "positive",
  },
  not_applicable: {
    label: "Not Applicable",
    description: "Claim does not describe a feature that could be cut or shipped.",
    tone: "neutral",
  },
};

export const informationTypeLabel: Record<string, string> = {
  fact: "Fact",
  official: "Official",
  report: "Report",
  leak: "Leak",
  rumour: "Rumour",
  speculation: "Speculation",
  prediction: "Prediction",
  interpretation: "Interpretation",
};

export const toneClass: Record<StatusDisplay["tone"], string> = {
  positive: "border-signal-confirmed/50 text-signal-confirmed",
  negative: "border-signal-disproven/50 text-signal-disproven",
  pending: "border-accent-brass/50 text-accent-brass",
  neutral: "border-hairline text-ink-400",
};

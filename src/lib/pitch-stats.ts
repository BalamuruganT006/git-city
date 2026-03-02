import { getSupabaseAdmin } from "@/lib/supabase";
import { SKY_AD_PLANS, type SkyAdPlanId } from "@/lib/skyAdPlans";

export interface PitchStats {
  developers: number;
  claimed: number;
  adCampaigns: number;
  uniqueBrands: number;
  shopPurchases: number;
  kudos: number;
  buildingVisits: number;
  achievements: number;
  daysOld: number;
  adRevenueBrlCents: number;
  shopRevenueUsdCents: number;
  shopRevenueBrlCents: number;
  totalRevenueBrl: number;
  conversionRate: string;
  formattedDevelopers: string;
  formattedClaimed: string;
  formattedAdCampaigns: string;
  formattedUniqueBrands: string;
  formattedShopPurchases: string;
  formattedKudos: string;
  formattedBuildingVisits: string;
  formattedAchievements: string;
  formattedDaysOld: string;
  formattedRevenue: string;
  formattedAdRevenue: string;
  formattedShopRevenue: string;
}

const LAUNCH_DATE = new Date("2026-02-19T00:00:00Z");

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtRounded(n: number): string {
  if (n >= 1000) {
    const rounded = Math.floor(n / 100) * 100;
    return fmt(rounded) + "+";
  }
  return fmt(n);
}

export async function getPitchStats(): Promise<PitchStats> {
  const admin = getSupabaseAdmin();

  const [
    devsResult,
    claimedResult,
    adsResult,
    shopCountResult,
    shopRevenueResult,
    kudosResult,
    visitsResult,
    achievementsResult,
  ] = await Promise.all([
    admin.from("developers").select("*", { count: "exact", head: true }),
    admin.from("developers").select("*", { count: "exact", head: true }).eq("claimed", true),
    admin.from("sky_ads").select("plan_id, purchaser_email").not("purchaser_email", "is", null),
    admin.from("purchases").select("*", { count: "exact", head: true }).eq("status", "completed").gt("amount_cents", 0),
    admin.from("purchases").select("amount_cents, currency").eq("status", "completed").gt("amount_cents", 0),
    admin.from("developer_kudos").select("*", { count: "exact", head: true }),
    admin.from("building_visits").select("*", { count: "exact", head: true }),
    admin.from("developer_achievements").select("*", { count: "exact", head: true }),
  ]);

  const developers = devsResult.count ?? 0;
  const claimed = claimedResult.count ?? 0;

  // Ad revenue: sum brl_cents from SKY_AD_PLANS for each paid ad
  const paidAds = adsResult.data ?? [];
  let adRevenueBrlCents = 0;
  const brandEmails = new Set<string>();
  for (const ad of paidAds) {
    const planId = ad.plan_id as SkyAdPlanId;
    const plan = SKY_AD_PLANS[planId];
    if (plan) {
      adRevenueBrlCents += plan.brl_cents;
    }
    if (ad.purchaser_email) {
      brandEmails.add(ad.purchaser_email);
    }
  }
  const adCampaigns = paidAds.length;
  const uniqueBrands = brandEmails.size;

  // Shop revenue: sum by currency
  const purchases = shopRevenueResult.data ?? [];
  let shopRevenueUsdCents = 0;
  let shopRevenueBrlCents = 0;
  for (const p of purchases) {
    if (p.currency === "usd") shopRevenueUsdCents += p.amount_cents;
    else if (p.currency === "brl") shopRevenueBrlCents += p.amount_cents;
  }
  const shopPurchases = shopCountResult.count ?? 0;

  const kudos = kudosResult.count ?? 0;
  const buildingVisits = visitsResult.count ?? 0;
  const achievements = achievementsResult.count ?? 0;

  const daysOld = Math.floor((Date.now() - LAUNCH_DATE.getTime()) / 86400000);

  // Total revenue in BRL (ad revenue is already BRL, shop USD * ~5.5 rough rate + shop BRL)
  const totalRevenueBrl = adRevenueBrlCents + shopRevenueBrlCents + Math.round(shopRevenueUsdCents * 5.5);
  const totalRevenueBrlFormatted = `R$${fmt(Math.floor(totalRevenueBrl / 100))}+`;

  const conversionRate = developers > 0 ? ((claimed / developers) * 100).toFixed(1) + "%" : "0%";

  // Format ad revenue in BRL
  const adRevenueBrlFormatted = `R$${fmt(Math.floor(adRevenueBrlCents / 100))}`;

  // Format shop revenue (prefer USD if available)
  let shopRevenueFormatted = "Early sales";
  if (shopRevenueUsdCents > 0) {
    shopRevenueFormatted = `$${fmt(Math.floor(shopRevenueUsdCents / 100))}`;
  } else if (shopRevenueBrlCents > 0) {
    shopRevenueFormatted = `R$${fmt(Math.floor(shopRevenueBrlCents / 100))}`;
  }

  return {
    developers,
    claimed,
    adCampaigns,
    uniqueBrands,
    shopPurchases,
    kudos,
    buildingVisits,
    achievements,
    daysOld,
    adRevenueBrlCents,
    shopRevenueUsdCents,
    shopRevenueBrlCents,
    totalRevenueBrl,
    conversionRate,
    formattedDevelopers: fmtRounded(developers),
    formattedClaimed: fmt(claimed),
    formattedAdCampaigns: fmt(adCampaigns),
    formattedUniqueBrands: fmt(uniqueBrands),
    formattedShopPurchases: fmt(shopPurchases),
    formattedKudos: fmt(kudos),
    formattedBuildingVisits: fmt(buildingVisits),
    formattedAchievements: fmt(achievements),
    formattedDaysOld: `${daysOld} days old`,
    formattedRevenue: totalRevenueBrlFormatted,
    formattedAdRevenue: adRevenueBrlFormatted,
    formattedShopRevenue: shopRevenueFormatted,
  };
}

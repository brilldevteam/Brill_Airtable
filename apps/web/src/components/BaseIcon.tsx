import {
  BookOpen, Briefcase, Building2, CalendarDays, Camera, Car, ClipboardCheck, Cloud, Coffee, Film, Gift, Globe, GraduationCap, Heart, Home,
  Image, Lightbulb, Megaphone, Music, Package, Palette, Rocket, Shield, ShoppingCart, Sparkles, Star, Target, Trophy, Truck, Users, Utensils, Wrench,
  type LucideIcon,
} from "lucide-react";
import { BASE_COLORS } from "../colors";

/** Icons a base can wear on the home page (stored by name). */
export const BASE_ICONS: Record<string, LucideIcon> = {
  users: Users, utensils: Utensils, "shopping-cart": ShoppingCart, cloud: Cloud, truck: Truck, heart: Heart, camera: Camera, film: Film,
  megaphone: Megaphone, briefcase: Briefcase, calendar: CalendarDays, book: BookOpen, building: Building2, car: Car, coffee: Coffee, gift: Gift,
  globe: Globe, "graduation-cap": GraduationCap, home: Home, image: Image, lightbulb: Lightbulb, music: Music, package: Package, palette: Palette,
  rocket: Rocket, shield: Shield, star: Star, target: Target, trophy: Trophy, wrench: Wrench, "clipboard-check": ClipboardCheck, sparkles: Sparkles,
};

/** A base's tile: its icon (or its first two letters) on its colour. */
export function BaseIcon({ name, color, icon, logo, baseId, size = 44 }: {
  name: string; color: string; icon?: string | null; logo?: string | null; baseId?: string; size?: number;
}) {
  const Icon = icon ? BASE_ICONS[icon] : undefined;
  if (logo && baseId) {
    return <img className="base-tile logo" src={`/api/bases/${baseId}/logo/${logo}`} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  }
  return (
    <span className="base-tile" style={{ width: size, height: size, background: BASE_COLORS[color] ?? BASE_COLORS.blue, fontSize: size * 0.36 }}>
      {Icon ? <Icon size={Math.round(size * 0.48)} strokeWidth={1.9} /> : name.slice(0, 2)}
    </span>
  );
}

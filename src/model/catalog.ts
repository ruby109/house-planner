/**
 * 家具库：日本住宅常见家具的标准俯视尺寸（mm）。
 * 尺寸取市售主流规格的代表值，放置后可在属性面板自由修改。
 */
import type { FurnitureCategory } from './types';

export interface CatalogItem {
  catalogId: string;
  /** 中文名（界面主显示） */
  name: string;
  /** 日文名（副显示，便于对照日本商品规格） */
  nameJa: string;
  /** 俯视宽 mm */
  w: number;
  /** 俯视深 mm */
  d: number;
  color: string;
  category: FurnitureCategory;
}

export const CATEGORY_ORDER: FurnitureCategory[] = [
  'bed',
  'table',
  'seating',
  'storage',
  'appliance',
  'other',
];

export const CATEGORY_LABELS: Record<FurnitureCategory, string> = {
  bed: '床铺',
  table: '桌子',
  seating: '座椅沙发',
  storage: '收纳',
  appliance: '家电',
  other: '其他',
};

const C = {
  bed: '#CBD9E8',
  table: '#DCD3C2',
  seating: '#D2DCCB',
  storage: '#E0D6E4',
  appliance: '#D6DCE2',
  other: '#E3DDD3',
} as const;

export const CATALOG: CatalogItem[] = [
  // ---------------------------------------------------------------- 床铺
  { catalogId: 'bed_single', name: '单人床', nameJa: 'シングルベッド', w: 970, d: 1950, color: C.bed, category: 'bed' },
  { catalogId: 'bed_semi_double', name: '小双人床', nameJa: 'セミダブルベッド', w: 1200, d: 1950, color: C.bed, category: 'bed' },
  { catalogId: 'bed_double', name: '双人床', nameJa: 'ダブルベッド', w: 1400, d: 1950, color: C.bed, category: 'bed' },
  { catalogId: 'bed_queen', name: '加大双人床', nameJa: 'クイーンベッド', w: 1600, d: 1950, color: C.bed, category: 'bed' },
  { catalogId: 'bed_bunk', name: '上下铺', nameJa: '二段ベッド', w: 1050, d: 2100, color: C.bed, category: 'bed' },
  { catalogId: 'futon', name: '被褥（地铺）', nameJa: '布団', w: 1000, d: 2000, color: C.bed, category: 'bed' },
  { catalogId: 'baby_bed', name: '婴儿床', nameJa: 'ベビーベッド', w: 700, d: 1200, color: C.bed, category: 'bed' },

  // ---------------------------------------------------------------- 桌子
  { catalogId: 'kotatsu', name: '暖桌', nameJa: 'こたつ', w: 750, d: 750, color: C.table, category: 'table' },
  { catalogId: 'dining_table_2', name: '餐桌（2 人）', nameJa: 'ダイニングテーブル 2人', w: 800, d: 750, color: C.table, category: 'table' },
  { catalogId: 'dining_table_4', name: '餐桌（4 人）', nameJa: 'ダイニングテーブル 4人', w: 1350, d: 800, color: C.table, category: 'table' },
  { catalogId: 'dining_table_6', name: '餐桌（6 人）', nameJa: 'ダイニングテーブル 6人', w: 1800, d: 900, color: C.table, category: 'table' },
  { catalogId: 'low_table', name: '矮桌', nameJa: 'ローテーブル', w: 1050, d: 550, color: C.table, category: 'table' },
  { catalogId: 'desk', name: '书桌', nameJa: 'デスク', w: 1100, d: 600, color: C.table, category: 'table' },
  { catalogId: 'pc_desk', name: '电脑桌', nameJa: 'パソコンデスク', w: 1200, d: 700, color: C.table, category: 'table' },
  { catalogId: 'dresser', name: '梳妆台', nameJa: 'ドレッサー', w: 800, d: 450, color: C.table, category: 'table' },

  // ---------------------------------------------------------------- 座椅沙发
  { catalogId: 'sofa_2', name: '沙发（2 人）', nameJa: '2人掛けソファ', w: 1500, d: 800, color: C.seating, category: 'seating' },
  { catalogId: 'sofa_3', name: '沙发（3 人）', nameJa: '3人掛けソファ', w: 1900, d: 850, color: C.seating, category: 'seating' },
  { catalogId: 'sofa_corner', name: 'L 型沙发', nameJa: 'コーナーソファ', w: 2200, d: 1600, color: C.seating, category: 'seating' },
  { catalogId: 'dining_chair', name: '餐椅', nameJa: 'ダイニングチェア', w: 450, d: 500, color: C.seating, category: 'seating' },
  { catalogId: 'office_chair', name: '办公椅', nameJa: 'オフィスチェア', w: 650, d: 650, color: C.seating, category: 'seating' },
  { catalogId: 'zaisu', name: '和室座椅', nameJa: '座椅子', w: 550, d: 600, color: C.seating, category: 'seating' },

  // ---------------------------------------------------------------- 收纳
  { catalogId: 'wardrobe', name: '衣柜', nameJa: '洋服タンス', w: 1200, d: 600, color: C.storage, category: 'storage' },
  { catalogId: 'chest', name: '五斗柜', nameJa: 'チェスト', w: 900, d: 450, color: C.storage, category: 'storage' },
  { catalogId: 'bookshelf', name: '书架', nameJa: '本棚', w: 900, d: 300, color: C.storage, category: 'storage' },
  { catalogId: 'tv_board', name: '电视柜', nameJa: 'テレビボード', w: 1500, d: 400, color: C.storage, category: 'storage' },
  { catalogId: 'shoe_box', name: '鞋柜', nameJa: 'シューズボックス', w: 900, d: 350, color: C.storage, category: 'storage' },
  { catalogId: 'color_box', name: '收纳格架', nameJa: 'カラーボックス', w: 420, d: 300, color: C.storage, category: 'storage' },

  // ---------------------------------------------------------------- 家电
  { catalogId: 'refrigerator', name: '冰箱', nameJa: '冷蔵庫', w: 600, d: 650, color: C.appliance, category: 'appliance' },
  { catalogId: 'washing_machine', name: '洗衣机', nameJa: '洗濯機', w: 600, d: 600, color: C.appliance, category: 'appliance' },
  { catalogId: 'tv_55', name: '电视（55 吋）', nameJa: 'テレビ 55型', w: 1240, d: 250, color: C.appliance, category: 'appliance' },
  { catalogId: 'microwave_rack', name: '微波炉架', nameJa: 'レンジ台', w: 600, d: 450, color: C.appliance, category: 'appliance' },
  { catalogId: 'aircon', name: '空调室内机', nameJa: 'エアコン', w: 800, d: 250, color: C.appliance, category: 'appliance' },

  // ---------------------------------------------------------------- 其他
  { catalogId: 'piano_upright', name: '立式钢琴', nameJa: 'アップライトピアノ', w: 1500, d: 600, color: C.other, category: 'other' },
  { catalogId: 'kitchen_counter', name: '厨房台', nameJa: 'キッチン（流し台）', w: 2550, d: 650, color: C.other, category: 'other' },
  { catalogId: 'bathtub', name: '浴缸', nameJa: '浴槽', w: 1600, d: 800, color: C.other, category: 'other' },
  { catalogId: 'toilet', name: '马桶', nameJa: 'トイレ', w: 700, d: 450, color: C.other, category: 'other' },
];

const CATALOG_INDEX: Map<string, CatalogItem> = new Map(
  CATALOG.map((item) => [item.catalogId, item]),
);

export function findCatalogItem(catalogId: string): CatalogItem | undefined {
  return CATALOG_INDEX.get(catalogId);
}

/** 按分类分组，顺序遵循 CATEGORY_ORDER */
export function catalogByCategory(items: CatalogItem[] = CATALOG): [FurnitureCategory, CatalogItem[]][] {
  return CATEGORY_ORDER.map((cat): [FurnitureCategory, CatalogItem[]] => [
    cat,
    items.filter((i) => i.category === cat),
  ]).filter(([, list]) => list.length > 0);
}

/** 关键字搜索（中文名 / 日文名 / catalogId，大小写不敏感） */
export function searchCatalog(keyword: string, items: CatalogItem[] = CATALOG): CatalogItem[] {
  const k = keyword.trim().toLowerCase();
  if (!k) return items;
  return items.filter(
    (i) =>
      i.name.toLowerCase().includes(k) ||
      i.nameJa.toLowerCase().includes(k) ||
      i.catalogId.toLowerCase().includes(k),
  );
}

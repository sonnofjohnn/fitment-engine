import { useEffect, useState } from "react";
import {
  useLoaderData,
  useActionData,
  useNavigation,
  Link,
  Form,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PRODUCTS_COUNT_QUERY = `#graphql
  query GetProductsCount($query: String!, $limit: Int) {
    productsCount(query: $query, limit: $limit) {
      count
      precision
    }
  }
`;

const COLLECTIONS_PAGE_QUERY = `#graphql
  query GetCollectionsPage($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: TITLE) {
      nodes {
        id
        handle
        legacyResourceId
        ruleSet {
          rules {
            column
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const MENUS_QUERY = `#graphql
  query GetMenusDashboardCount($first: Int!) {
    menus(first: $first) {
      nodes {
        id
        title
        handle
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildExpectedCollectionHandle({ make, model, trim }) {
  const parts = [];

  if (make) parts.push(slugify(make));
  if (model) parts.push(slugify(model));
  if (trim) parts.push(slugify(trim));

  parts.push("coilovers");

  return parts.join("-");
}

function buildFitmentTree(rows) {
  const makesMap = new Map();

  for (const row of rows) {
    const make = String(row.make || "").trim();
    const model = String(row.model || "").trim();
    const trim = String(row.trim || "").trim();

    if (!make || !model) continue;

    if (!makesMap.has(make)) {
      makesMap.set(make, new Map());
    }

    const modelsMap = makesMap.get(make);

    if (!modelsMap.has(model)) {
      modelsMap.set(model, new Set());
    }

    if (trim) {
      modelsMap.get(model).add(trim);
    }
  }

  return makesMap;
}

async function shopifyGraphQL(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();

  if (json.errors) {
    throw new Error(JSON.stringify(json.errors, null, 2));
  }

  return json;
}

async function getProductsCount(admin, query) {
  const data = await shopifyGraphQL(admin, PRODUCTS_COUNT_QUERY, {
    query,
    limit: null,
  });

  return data?.data?.productsCount?.count || 0;
}

async function getAllCollections(admin) {
  const allCollections = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL(admin, COLLECTIONS_PAGE_QUERY, {
      first: 250,
      after,
    });

    const connection = data?.data?.collections;
    const nodes = connection?.nodes || [];
    const pageInfo = connection?.pageInfo || {};

    allCollections.push(...nodes);

    hasNextPage = Boolean(pageInfo.hasNextPage);
    after = pageInfo.endCursor || null;
  }

  return allCollections;
}

async function findMenuByHandle(admin, handle) {
  const query = `#graphql
    query FindMenusForExactHandleMatch {
      menus(first: 100) {
        nodes {
          id
          title
          handle
          isDefault
        }
      }
    }
  `;

  const data = await shopifyGraphQL(admin, query);
  const menus = data?.data?.menus?.nodes || [];

  return menus.find((menu) => menu.handle === handle) || null;
}

async function createMenu(admin, title, handle, items) {
  const mutation = `#graphql
    mutation CreateMenu($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
      menuCreate(title: $title, handle: $handle, items: $items) {
        menu {
          id
          title
          handle
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyGraphQL(admin, mutation, {
    title,
    handle,
    items,
  });

  const payload = data?.data?.menuCreate;

  if (payload?.userErrors?.length) {
    throw new Error(
      `menuCreate failed for "${handle}": ${payload.userErrors
        .map((e) => e.message)
        .join(", ")}`
    );
  }

  return payload.menu;
}

async function updateMenu(admin, id, title, items) {
  const mutation = `#graphql
    mutation UpdateMenu($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, title: $title, items: $items) {
        menu {
          id
          title
          handle
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyGraphQL(admin, mutation, {
    id,
    title,
    items,
  });

  const payload = data?.data?.menuUpdate;

  if (payload?.userErrors?.length) {
    throw new Error(
      `menuUpdate failed: ${payload.userErrors
        .map((e) => e.message)
        .join(", ")}`
    );
  }

  return payload.menu;
}

function buildCreateItems(values) {
  return [...new Set(values)]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({
      title: value,
      type: "HTTP",
      url: "#",
      items: [],
    }));
}

function buildUpdateItems(values) {
  return [...new Set(values)]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({
      title: value,
      type: "HTTP",
      url: "#",
      items: [],
    }));
}

async function upsertMenu(admin, title, handle, values) {
  const existing = await findMenuByHandle(admin, handle);

  if (!existing) {
    const created = await createMenu(
      admin,
      title,
      handle,
      buildCreateItems(values)
    );
    return { action: "created", handle, title: created.title };
  }

  const updated = await updateMenu(
    admin,
    existing.id,
    title,
    buildUpdateItems(values)
  );

  return { action: "updated", handle, title: updated.title };
}

async function syncMenusFromFitmentOptions(admin) {
  const fitmentOptions = await db.fitmentOption.findMany({
    orderBy: [{ make: "asc" }, { model: "asc" }, { trim: "asc" }],
  });

  const tree = buildFitmentTree(fitmentOptions);
  const results = [];

  const makeNames = [...tree.keys()];
  results.push(
    await upsertMenu(admin, "Vehicle Makes", "vehicle-makes", makeNames)
  );

  for (const [make, modelsMap] of tree.entries()) {
    const makeHandle = slugify(make);
    const modelNames = [...modelsMap.keys()];

    results.push(
      await upsertMenu(
        admin,
        `Models for ${make}`,
        `models-${makeHandle}`,
        modelNames
      )
    );

    for (const [model, trimsSet] of modelsMap.entries()) {
      const modelHandle = slugify(model);
      const trimNames = [...trimsSet];

      if (trimNames.length > 0) {
        results.push(
          await upsertMenu(
            admin,
            `Trims for ${make} ${model}`,
            `trims-${makeHandle}-${modelHandle}`,
            trimNames
          )
        );
      }
    }
  }

  return results;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const fitmentRows = await db.fitmentOption.findMany({
    orderBy: [{ make: "asc" }, { model: "asc" }, { trim: "asc" }],
    select: {
      id: true,
      make: true,
      model: true,
      trim: true,
    },
  });

  const totalVehicleCombinations = fitmentRows.length;

  const expectedHandles = fitmentRows.map((row) =>
    buildExpectedCollectionHandle({
      make: row.make,
      model: row.model,
      trim: row.trim,
    })
  );

  const uniqueExpectedHandles = [...new Set(expectedHandles)];

  const [missingFitmentCount, assignedFitmentCount, collectionsData, menusData] =
    await Promise.all([
      getProductsCount(
        admin,
        "status:active AND (-metafields.custom.vehicle_make:* OR -metafields.custom.vehicle_model:*)"
      ),
      getProductsCount(
        admin,
        "status:active AND metafields.custom.vehicle_make:* AND metafields.custom.vehicle_model:*"
      ),
      getAllCollections(admin),
      shopifyGraphQL(admin, MENUS_QUERY, { first: 100 }),
    ]);

  const collectionMap = new Map(
    collectionsData.map((collection) => [
      collection.handle,
      {
        exists: true,
        isSmart: Boolean(collection?.ruleSet?.rules?.length),
      },
    ])
  );

  let existingExpectedCollections = 0;
  let missingExpectedCollections = 0;
  let smartExpectedCollections = 0;
  let manualExpectedCollections = 0;

  for (const handle of uniqueExpectedHandles) {
    const matched = collectionMap.get(handle);

    if (!matched) {
      missingExpectedCollections += 1;
      continue;
    }

    existingExpectedCollections += 1;

    if (matched.isSmart) {
      smartExpectedCollections += 1;
    } else {
      manualExpectedCollections += 1;
    }
  }

  const menusConnection = menusData?.data?.menus;
  const menuCount = menusConnection?.nodes?.length || 0;
  const hasMoreMenus = Boolean(menusConnection?.pageInfo?.hasNextPage);

  return {
    stats: {
      missingFitmentCount,
      assignedFitmentCount,
      totalVehicleCombinations,
      existingExpectedCollections,
      missingExpectedCollections,
      smartExpectedCollections,
      manualExpectedCollections,
      menuCount,
      hasMoreMenus,
      totalShopifyCollections: collectionsData.length,
    },
  };
};

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType")?.toString();

  if (actionType === "syncMenus") {
    try {
      const results = await syncMenusFromFitmentOptions(admin);

      return {
        success: true,
        message: `Menus synced successfully. ${results.length} menu(s) processed.`,
        syncedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        message: error?.message || "Failed to sync menus.",
      };
    }
  }

  return null;
}

function StatCard({ label, value, tone = "default", subtext = "" }) {
  const tones = {
    default: {
      background: "white",
      border: "#e5e7eb",
      value: "#111827",
    },
    success: {
      background: "#f0fdf4",
      border: "#bbf7d0",
      value: "#166534",
    },
    warning: {
      background: "#fffbeb",
      border: "#fde68a",
      value: "#92400e",
    },
    danger: {
      background: "#fef2f2",
      border: "#fecaca",
      value: "#b91c1c",
    },
    info: {
      background: "#eff6ff",
      border: "#bfdbfe",
      value: "#1d4ed8",
    },
  };

  const style = tones[tone] || tones.default;

  return (
    <div
      style={{
        background: style.background,
        border: `1px solid ${style.border}`,
        borderRadius: "12px",
        padding: "16px",
      }}
    >
      <div
        style={{
          fontSize: "13px",
          color: "#6b7280",
          marginBottom: "8px",
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: "28px",
          fontWeight: 700,
          lineHeight: 1,
          color: style.value,
          marginBottom: subtext ? "8px" : 0,
        }}
      >
        {value}
      </div>

      {subtext ? (
        <div
          style={{
            fontSize: "12px",
            color: "#6b7280",
            lineHeight: 1.4,
          }}
        >
          {subtext}
        </div>
      ) : null}
    </div>
  );
}

function formatLastSynced(value) {
  if (!value) return "Not synced yet";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not synced yet";
  }

  return date.toLocaleString();
}

export default function Index() {
  const { stats } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSyncing =
    navigation.state === "submitting" &&
    navigation.formData?.get("actionType") === "syncMenus";

  const [lastSynced, setLastSynced] = useState("");

  useEffect(() => {
    const saved = window.localStorage.getItem("vehicleFitmentLastSynced");
    if (saved) {
      setLastSynced(saved);
    }
  }, []);

  useEffect(() => {
    if (actionData?.success && actionData?.syncedAt) {
      setLastSynced(actionData.syncedAt);
      window.localStorage.setItem(
        "vehicleFitmentLastSynced",
        actionData.syncedAt
      );
    }
  }, [actionData]);

  return (
    <s-page heading="Vehicle Fitment Admin">
      <s-section>
        <div
          style={{
            marginBottom: "20px",
            background: "white",
            border: "1px solid #e5e7eb",
            borderRadius: "12px",
            padding: "18px",
          }}
        >
          <div
            style={{
              fontSize: "20px",
              fontWeight: 700,
              marginBottom: "8px",
              color: "#111827",
            }}
          >
            Vehicle fitment dashboard
          </div>

          <div
            style={{
              color: "#4b5563",
              lineHeight: 1.6,
              marginBottom: "14px",
            }}
          >
            Manage metafields, assign fitment to products, monitor missing data,
            create smart collections, and keep Shopify navigation in sync.
          </div>

          <div
            style={{
              display: "flex",
              gap: "10px",
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <Link
              to="/app/fitment-setup"
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "10px 14px",
                borderRadius: "8px",
                background: "#111827",
                color: "white",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Fitment Setup
            </Link>

            <Link
              to="/app/vehicle-data"
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "10px 14px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                background: "white",
                color: "#111827",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Vehicle Data Manager
            </Link>

            <Link
              to="/app/fitment-assign"
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "10px 14px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                background: "white",
                color: "#111827",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Fitment Assignment
            </Link>

            <Form method="post">
              <input type="hidden" name="actionType" value="syncMenus" />
              <button
                type="submit"
                disabled={isSyncing}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  border: "1px solid #111827",
                  background: "#111827",
                  color: "white",
                  fontWeight: 600,
                  cursor: isSyncing ? "wait" : "pointer",
                  opacity: isSyncing ? 0.8 : 1,
                }}
              >
                {isSyncing ? "Syncing Menus..." : "Sync Menus"}
              </button>
            </Form>
          </div>

          <div
            style={{
              marginTop: "12px",
              fontSize: "13px",
              color: "#6b7280",
            }}
          >
            Last synced: {formatLastSynced(lastSynced)}
          </div>

          {actionData?.message ? (
            <div
              style={{
                marginTop: "12px",
                padding: "10px 12px",
                borderRadius: "8px",
                background: actionData.success ? "#dcfce7" : "#fee2e2",
                border: `1px solid ${actionData.success ? "#22c55e" : "#ef4444"}`,
                fontWeight: 500,
                color: "#111827",
              }}
            >
              {actionData.success ? "✓ " : "⚠ "} {actionData.message}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: "12px",
            marginBottom: "20px",
          }}
        >
          <StatCard
            label="Missing Fitment"
            value={stats.missingFitmentCount}
            tone="danger"
            subtext="Current active products missing make and model"
          />
          <StatCard
            label="Assigned Products"
            value={stats.assignedFitmentCount}
            tone="success"
            subtext="Current active products with make and model"
          />
          <StatCard
            label="Vehicle Combinations"
            value={stats.totalVehicleCombinations}
            tone="info"
            subtext="Rows saved in your fitment database"
          />
          <StatCard
            label="Missing Collections"
            value={stats.missingExpectedCollections}
            tone="warning"
            subtext="Collections that are currently missing or not matched to your combinations"
          />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: "12px",
            marginBottom: "20px",
          }}
        >
          <StatCard
            label="Existing Expected Collections"
            value={stats.existingExpectedCollections}
            tone="success"
            subtext="Current amount of collections that match your combinations"
          />
          <StatCard
            label="Smart Collections"
            value={stats.smartExpectedCollections}
            tone="info"
            subtext="Amount of smart collections currently in your store"
          />
          <StatCard
            label="Manual Collections"
            value={stats.manualExpectedCollections}
            tone="warning"
            subtext="Current amount of collections not set to smart"
          />
          <StatCard
            label="Menus"
            value={stats.menuCount}
            tone="default"
            subtext={
              stats.hasMoreMenus
                ? "First 100 menus loaded for dashboard"
                : "Navigation menus currently found"
            }
          />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1fr",
            gap: "16px",
          }}
        >
          <div
            style={{
              background: "white",
              border: "1px solid #e5e7eb",
              borderRadius: "12px",
              padding: "16px",
            }}
          >
            <div
              style={{
                fontSize: "16px",
                fontWeight: 700,
                marginBottom: "10px",
                color: "#111827",
              }}
            >
              Recommended workflow
            </div>

            <div style={{ color: "#374151", lineHeight: 1.8, fontSize: "14px" }}>
              <div>
                <strong>1.</strong> Run <strong>Fitment Setup</strong> to create
                the product metafields and keep them smart-collection ready and
                filterable.
              </div>
              <div>
                <strong>2.</strong> Use <strong>Vehicle Data Manager</strong> to
                add or review make / model / trim combinations and create smart
                collections.
              </div>
              <div>
                <strong>3.</strong> Use <strong>Fitment Assignment</strong> to
                save fitment directly onto products.
              </div>
              <div>
                <strong>4.</strong> Use the missing-fitment filter to find
                products that still need make or model assigned.
              </div>
              <div>
                <strong>5.</strong> Click <strong>Sync Menus</strong> whenever
                you add new combinations. Sync Menus will automatically create
                the menus for you.
              </div>
            </div>
          </div>

          <div
            style={{
              background: "white",
              border: "1px solid #e5e7eb",
              borderRadius: "12px",
              padding: "16px",
            }}
          >
            <div
              style={{
                fontSize: "16px",
                fontWeight: 700,
                marginBottom: "10px",
                color: "#111827",
              }}
            >
              Dashboard notes
            </div>

            <div style={{ color: "#374151", lineHeight: 1.8, fontSize: "14px" }}>
              <div>
                <strong>Missing Fitment</strong> counts active products missing
                either make or model.
              </div>
              <div>
                <strong>Missing Collections</strong> compares expected fitment
                handles from your database against actual Shopify collections.
              </div>
              <div>
                <strong>Manual Collections</strong> means a matching collection
                exists, but it is not currently smart.
              </div>
              <div>
                <strong>Menus</strong> shows current navigation count from
                Shopify.
              </div>
              <div style={{ marginTop: "8px", color: "#6b7280" }}>
                Total Shopify collections scanned: {stats.totalShopifyCollections}
              </div>
            </div>
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
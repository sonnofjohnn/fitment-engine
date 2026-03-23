import {
  useLoaderData,
  useActionData,
  useNavigation,
  Form,
  useFetcher,
  Link,
} from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const COLLECTIONS_QUERY = `#graphql
  query GetCollectionsForStatusCheck($first: Int!) {
    collections(first: $first, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        legacyResourceId
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const COLLECTION_CREATE_MUTATION = `#graphql
  mutation CreateCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        title
        handle
        legacyResourceId
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const COLLECTION_DELETE_MUTATION = `#graphql
  mutation DeleteCollection($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors {
        field
        message
      }
    }
  }
`;

const METAFIELD_RULE_DEFINITIONS_QUERY = `#graphql
  query GetCollectionRuleMetafieldDefinitions {
    collectionRulesConditions {
      ruleType
      ruleObject {
        ... on CollectionRuleMetafieldCondition {
          metafieldDefinition {
            id
            namespace
            key
          }
        }
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

function buildCollectionTitle({ make, model, trim }) {
  const parts = [];

  if (make) parts.push(String(make).trim());
  if (model) parts.push(String(model).trim());
  if (trim) parts.push(String(trim).trim());

  parts.push("Coilovers");

  return parts.join(" ");
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

function buildAdminCollectionUrl(adminStoreHandle, legacyResourceId) {
  return `https://admin.shopify.com/store/${adminStoreHandle}/collections/${legacyResourceId}`;
}

function buildSmartCollectionRules({
  make,
  model,
  trim,
  makeDefinitionId,
  modelDefinitionId,
  trimDefinitionId,
}) {
  const rules = [
    {
      column: "PRODUCT_METAFIELD_DEFINITION",
      relation: "EQUALS",
      condition: String(make),
      conditionObjectId: makeDefinitionId,
    },
    {
      column: "PRODUCT_METAFIELD_DEFINITION",
      relation: "EQUALS",
      condition: String(model),
      conditionObjectId: modelDefinitionId,
    },
  ];

  if (trim && trimDefinitionId) {
    rules.push({
      column: "PRODUCT_METAFIELD_DEFINITION",
      relation: "EQUALS",
      condition: String(trim),
      conditionObjectId: trimDefinitionId,
    });
  }

  return rules;
}

async function shopifyGraphQL(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();

  if (json.errors) {
    throw new Error(JSON.stringify(json.errors, null, 2));
  }

  return json;
}

async function deleteCollectionIfCreatedAsManual(admin, collectionId) {
  const data = await shopifyGraphQL(admin, COLLECTION_DELETE_MUTATION, {
    input: {
      id: collectionId,
    },
  });

  const payload = data?.data?.collectionDelete;

  if (payload?.userErrors?.length) {
    throw new Error(
      `Collection was created as manual, and delete failed: ${payload.userErrors
        .map((e) => e.message)
        .join(", ")}`
    );
  }

  return payload?.deletedCollectionId || null;
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
    await upsertMenu(admin, "Primary Attributes", "vehicle-makes", makeNames)
  );

  for (const [make, modelsMap] of tree.entries()) {
    const makeHandle = slugify(make);
    const modelNames = [...modelsMap.keys()];

    results.push(
      await upsertMenu(
        admin,
        `Secondary Attributes for ${make}`,
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
            `Tertiary Attributes for ${make} ${model}`,
            `trims-${makeHandle}-${modelHandle}`,
            trimNames
          )
        );
      }
    }
  }

  return results;
}

function buildPageUrl(page, status, perPage) {
  const params = new URLSearchParams();

  if (status && status !== "all") {
    params.set("status", status);
  }

  if (perPage && perPage !== 25) {
    params.set("perPage", String(perPage));
  }

  if (page > 1) {
    params.set("page", String(page));
  }

  const query = params.toString();
  return `/app/vehicle-data${query ? `?${query}` : ""}`;
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const status = url.searchParams.get("status")?.trim() || "all";

  const pageParam = Number(url.searchParams.get("page") || "1");
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const allowedPerPage = [25, 50, 100];
  const perPageParam = Number(url.searchParams.get("perPage") || "25");
  const perPage = allowedPerPage.includes(perPageParam) ? perPageParam : 25;

  const adminStoreHandle = session.shop.replace(".myshopify.com", "");

  const fitmentOptionsRaw = await db.fitmentOption.findMany({
    orderBy: [{ make: "asc" }, { model: "asc" }, { trim: "asc" }],
  });

  const collectionsResponse = await admin.graphql(COLLECTIONS_QUERY, {
    variables: { first: 250 },
  });

  const collectionsJson = await collectionsResponse.json();
  const collections = collectionsJson?.data?.collections?.nodes || [];

  const collectionMap = new Map(
    collections.map((collection) => [
      collection.handle,
      {
        exists: true,
        isSmart: Boolean(collection?.ruleSet?.rules?.length),
        adminUrl: buildAdminCollectionUrl(
          adminStoreHandle,
          collection.legacyResourceId
        ),
      },
    ])
  );

  let fitmentOptions = fitmentOptionsRaw.map((item) => {
    const expectedCollectionHandle = buildExpectedCollectionHandle({
      make: item.make,
      model: item.model,
      trim: item.trim,
    });

    const matchedCollection = collectionMap.get(expectedCollectionHandle);

    return {
      ...item,
      expectedCollectionHandle,
      collectionExists: Boolean(matchedCollection),
      collectionIsSmart: Boolean(matchedCollection?.isSmart),
      collectionAdminUrl: matchedCollection?.adminUrl || null,
    };
  });

  if (status === "missing") {
    fitmentOptions = fitmentOptions.filter((item) => !item.collectionExists);
  }

  const totalItems = fitmentOptions.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * perPage;
  const endIndex = startIndex + perPage;
  const paginatedFitmentOptions = fitmentOptions.slice(startIndex, endIndex);

  return {
    fitmentOptions: paginatedFitmentOptions,
    collectionCountChecked: collections.length,
    hasMoreCollections:
      collectionsJson?.data?.collections?.pageInfo?.hasNextPage || false,
    status,
    page: safePage,
    perPage,
    totalItems,
    totalPages,
    hasPreviousPage: safePage > 1,
    hasNextPage: safePage < totalPages,
    previousPageUrl: buildPageUrl(safePage - 1, status, perPage),
    nextPageUrl: buildPageUrl(safePage + 1, status, perPage),
    showAllUrl: buildPageUrl(1, "all", perPage),
    showMissingUrl: buildPageUrl(1, "missing", perPage),
    show25Url: buildPageUrl(1, status, 25),
    show50Url: buildPageUrl(1, status, 50),
    show100Url: buildPageUrl(1, status, 100),
  };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);

  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "syncMenus") {
    try {
      const results = await syncMenusFromFitmentOptions(admin);

      return {
        success: true,
        message: `Collection menus synced successfully. ${results.length} menu(s) processed.`,
        syncResults: results,
      };
    } catch (error) {
      console.error("SYNC MENUS ERROR:", error);

      return {
        success: false,
        message: error.message || "Failed to sync collection menus.",
      };
    }
  }

  if (actionType === "createCollection") {
    const make = formData.get("make")?.toString().trim() || "";
    const model = formData.get("model")?.toString().trim() || "";
    const trim = formData.get("trim")?.toString().trim() || "";

    if (!make || !model) {
      return {
        success: false,
        message: "Primary and Secondary attributes are required to create a collection.",
      };
    }

    const handle = buildExpectedCollectionHandle({ make, model, trim });
    const title = buildCollectionTitle({ make, model, trim });
    const adminStoreHandle = session.shop.replace(".myshopify.com", "");

    try {
      const defsData = await shopifyGraphQL(
        admin,
        METAFIELD_RULE_DEFINITIONS_QUERY
      );

      const conditions = defsData?.data?.collectionRulesConditions || [];

      const getDefinition = (key) =>
        conditions.find(
          (item) =>
            item.ruleType === "PRODUCT_METAFIELD_DEFINITION" &&
            item?.ruleObject?.metafieldDefinition?.namespace === "custom" &&
            item?.ruleObject?.metafieldDefinition?.key === key
        )?.ruleObject?.metafieldDefinition;

      const makeDefinition = getDefinition("vehicle_make");
      const modelDefinition = getDefinition("vehicle_model");
      const trimDefinition = getDefinition("vehicle_trim");

      if (!makeDefinition || !modelDefinition) {
        return {
          success: false,
          message:
            "Valid smart collection metafield definitions were not found for custom.vehicle_make and custom.vehicle_model.",
        };
      }

      if (trim && !trimDefinition) {
        return {
          success: false,
          message:
            "Valid smart collection metafield definition was not found for custom.vehicle_trim.",
        };
      }

      const rules = buildSmartCollectionRules({
        make,
        model,
        trim,
        makeDefinitionId: makeDefinition.id,
        modelDefinitionId: modelDefinition.id,
        trimDefinitionId: trimDefinition?.id || null,
      });

      const data = await shopifyGraphQL(admin, COLLECTION_CREATE_MUTATION, {
        input: {
          title,
          handle,
          ruleSet: {
            appliedDisjunctively: false,
            rules,
          },
        },
      });

      const payload = data?.data?.collectionCreate;

      if (payload?.userErrors?.length) {
        return {
          success: false,
          message: payload.userErrors.map((e) => e.message).join(", "),
        };
      }

      const createdCollection = payload?.collection;
      const createdRules = createdCollection?.ruleSet?.rules || [];

      if (!createdCollection?.id) {
        return {
          success: false,
          message: "Shopify did not return a created collection.",
        };
      }

      if (!createdRules.length) {
        await deleteCollectionIfCreatedAsManual(admin, createdCollection.id);

        return {
          success: false,
          message:
            "Shopify created a manual collection instead of a smart collection, so it was deleted automatically.",
        };
      }

      return {
        success: true,
        message: `SEO collection created: ${handle}`,
        createdCollectionAdminUrl: buildAdminCollectionUrl(
          adminStoreHandle,
          createdCollection.legacyResourceId
        ),
      };
    } catch (error) {
      console.error("CREATE SMART COLLECTION ERROR:", error);

      return {
        success: false,
        message: error.message || "Failed to create SEO collection.",
      };
    }
  }

  if (actionType === "create") {
    const make = formData.get("make")?.toString().trim() || "";
    const model = formData.get("model")?.toString().trim() || "";
    const trim = formData.get("trim")?.toString().trim() || "";

    if (!make || !model) {
      return {
        success: false,
        message: "Primary and Secondary attributes are required. Tertiary is optional.",
      };
    }

    const exists = await db.fitmentOption.findFirst({
      where: { make, model, trim },
    });

    if (exists) {
      return {
        success: false,
        message: "That attribute combination already exists.",
      };
    }

    await db.fitmentOption.create({
      data: { make, model, trim },
    });

    return {
      success: true,
      message: "Attribute combination added.",
    };
  }

  if (actionType === "delete") {
    const id = formData.get("id")?.toString();

    if (!id) {
      return {
        success: false,
        message: "Missing row ID.",
      };
    }

    await db.fitmentOption.delete({
      where: { id },
    });

    return {
      success: true,
      message: "Deleted.",
    };
  }

  return { success: false, message: "Invalid action." };
}

export default function VehicleDataPage() {
  const {
    fitmentOptions,
    collectionCountChecked,
    hasMoreCollections,
    status,
    page,
    perPage,
    totalItems,
    totalPages,
    hasPreviousPage,
    hasNextPage,
    previousPageUrl,
    nextPageUrl,
    showAllUrl,
    showMissingUrl,
    show25Url,
    show50Url,
    show100Url,
  } = useLoaderData();

  const actionData = useActionData();
  const navigation = useNavigation();
  const syncFetcher = useFetcher();

  const isSubmitting = navigation.state === "submitting";
  const isSyncing = syncFetcher.state !== "idle";

  return (
    <s-page heading="Attribute Data">
      <s-section heading="Add attribute record">
        <s-paragraph>
          Add structured attribute combinations used for product organization,
          SEO collection generation, and menu syncing.
        </s-paragraph>

        {actionData?.message && (
          <div
            style={{
              marginBottom: "16px",
              padding: "12px",
              borderRadius: "8px",
              background: actionData.success ? "#d1fae5" : "#fee2e2",
              border: "1px solid",
              borderColor: actionData.success ? "#10b981" : "#ef4444",
            }}
          >
            {actionData.success ? "✓ " : "⚠ "} {actionData.message}

            {actionData?.createdCollectionAdminUrl ? (
              <div style={{ marginTop: "8px" }}>
                <a
                  href={actionData.createdCollectionAdminUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#2563eb", textDecoration: "underline" }}
                >
                  Open collection in admin
                </a>
              </div>
            ) : null}
          </div>
        )}

        <Form method="post">
          <input type="hidden" name="actionType" value="create" />

          <div style={{ display: "grid", gap: "10px", maxWidth: "400px" }}>
            <input name="make" placeholder="Primary Attribute" />
            <input name="model" placeholder="Secondary Attribute" />
            <input name="trim" placeholder="Tertiary Attribute (optional)" />

            <s-button type="submit" {...(isSubmitting ? { loading: true } : {})}>
              Add Attribute Record
            </s-button>
          </div>
        </Form>
      </s-section>

      <s-section heading="Saved attribute records">
        <div style={{ marginBottom: "16px" }}>
          <syncFetcher.Form method="post">
            <input type="hidden" name="actionType" value="syncMenus" />
            <s-button
              type="submit"
              {...(isSyncing ? { loading: true, disabled: true } : {})}
            >
              {isSyncing ? "Syncing Collection Menus..." : "Sync Collection Menus"}
            </s-button>
          </syncFetcher.Form>

          {syncFetcher.data?.message && (
            <div
              style={{
                marginTop: "12px",
                padding: "12px",
                borderRadius: "8px",
                background: syncFetcher.data.success ? "#dbeafe" : "#fee2e2",
                border: "1px solid",
                borderColor: syncFetcher.data.success ? "#3b82f6" : "#ef4444",
              }}
            >
              {syncFetcher.data.success ? "✓ " : "⚠ "}{" "}
              {syncFetcher.data.message}
            </div>
          )}

          {syncFetcher.data?.syncResults?.length > 0 && (
            <div
              style={{
                marginTop: "12px",
                padding: "12px",
                border: "1px solid #ddd",
                borderRadius: "8px",
                background: "#fafafa",
              }}
            >
              <strong>Menus processed:</strong>
              <div style={{ marginTop: "8px", display: "grid", gap: "6px" }}>
                {syncFetcher.data.syncResults.map((item, index) => (
                  <div key={`${item.handle}-${index}`}>
                    {item.action === "created" ? "✓ Created" : "↻ Updated"}: {" "}
                    <code>{item.handle}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            gap: "12px",
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: "10px",
          }}
        >
          <Link
            to={showAllUrl}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              textDecoration: "none",
              color: "inherit",
              background: status === "all" ? "#f3f4f6" : "white",
              fontWeight: status === "all" ? 600 : 400,
            }}
          >
            Show All
          </Link>

          <Link
            to={showMissingUrl}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              textDecoration: "none",
              color: "inherit",
              background: status === "missing" ? "#f3f4f6" : "white",
              fontWeight: status === "missing" ? 600 : 400,
            }}
          >
            Show Missing Collections Only
          </Link>
        </div>

        <div
          style={{
            display: "flex",
            gap: "8px",
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: "12px",
          }}
        >
          <span style={{ fontSize: "13px", color: "#6b7280", fontWeight: 600 }}>
            Rows per page:
          </span>

          <Link
            to={show25Url}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "6px 12px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              textDecoration: "none",
              color: "inherit",
              background: perPage === 25 ? "#f3f4f6" : "white",
              fontWeight: perPage === 25 ? 600 : 400,
              fontSize: "13px",
            }}
          >
            25
          </Link>

          <Link
            to={show50Url}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "6px 12px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              textDecoration: "none",
              color: "inherit",
              background: perPage === 50 ? "#f3f4f6" : "white",
              fontWeight: perPage === 50 ? 600 : 400,
              fontSize: "13px",
            }}
          >
            50
          </Link>

          <Link
            to={show100Url}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "6px 12px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              textDecoration: "none",
              color: "inherit",
              background: perPage === 100 ? "#f3f4f6" : "white",
              fontWeight: perPage === 100 ? 600 : 400,
              fontSize: "13px",
            }}
          >
            100
          </Link>
        </div>

        <div
          style={{
            marginBottom: "8px",
            fontSize: "13px",
            color: "#6b7280",
          }}
        >
          Checked {collectionCountChecked} collection(s) in Shopify
          {hasMoreCollections ? " (first 250 only for now)" : ""}.
        </div>

        <div
          style={{
            marginBottom: "12px",
            fontSize: "13px",
            color: "#6b7280",
          }}
        >
          Showing {totalItems === 0 ? 0 : (page - 1) * perPage + 1}-
          {Math.min(page * perPage, totalItems)} of {totalItems} attribute record(s).
          Page {page} of {totalPages}.
        </div>

        {fitmentOptions.length === 0 ? (
          <s-paragraph>No attribute records found for this filter.</s-paragraph>
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            {fitmentOptions.map((item) => (
              <div
                key={item.id}
                style={{
                  border: "1px solid #ddd",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  display: "grid",
                  gap: "6px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: "10px",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, lineHeight: 1.25 }}>
                      {item.make} / {item.model}
                      {item.trim ? ` / ${item.trim}` : ""}
                    </div>

                    <div
                      style={{
                        fontSize: "12px",
                        color: "#4b5563",
                        marginTop: "4px",
                        wordBreak: "break-word",
                      }}
                    >
                      Handle: <code>{item.expectedCollectionHandle}</code>
                    </div>
                  </div>

                  <span
                    style={{
                      display: "inline-block",
                      padding: "3px 9px",
                      borderRadius: "999px",
                      fontSize: "11px",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      background: item.collectionExists
                        ? item.collectionIsSmart
                          ? "#dcfce7"
                          : "#fef3c7"
                        : "#fee2e2",
                      color: item.collectionExists
                        ? item.collectionIsSmart
                          ? "#166534"
                          : "#92400e"
                        : "#991b1b",
                      border: `1px solid ${
                        item.collectionExists
                          ? item.collectionIsSmart
                            ? "#86efac"
                            : "#fcd34d"
                          : "#fca5a5"
                      }`,
                    }}
                  >
                    {item.collectionExists
                      ? item.collectionIsSmart
                        ? "Smart collection exists"
                        : "Manual collection exists"
                      : "Collection missing"}
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  {!item.collectionExists ? (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="actionType"
                        value="createCollection"
                      />
                      <input type="hidden" name="make" value={item.make} />
                      <input type="hidden" name="model" value={item.model} />
                      <input type="hidden" name="trim" value={item.trim || ""} />
                      <s-button type="submit">Create SEO Collection</s-button>
                    </Form>
                  ) : null}

                  {item.collectionExists && item.collectionAdminUrl ? (
                    <a
                      href={item.collectionAdminUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "7px 12px",
                        borderRadius: "8px",
                        border: "1px solid #cbd5e1",
                        textDecoration: "none",
                        color: "inherit",
                        background: "white",
                        fontSize: "13px",
                        lineHeight: 1.2,
                      }}
                    >
                      Open in Admin
                    </a>
                  ) : null}

                  <Form method="post">
                    <input type="hidden" name="actionType" value="delete" />
                    <input type="hidden" name="id" value={item.id} />
                    <s-button type="submit">Delete</s-button>
                  </Form>
                </div>
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: "12px",
            alignItems: "center",
            flexWrap: "wrap",
            marginTop: "16px",
          }}
        >
          {hasPreviousPage ? (
            <Link
              to={previousPageUrl}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "8px 14px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                textDecoration: "none",
                color: "inherit",
                background: "white",
              }}
            >
              Previous
            </Link>
          ) : (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "8px 14px",
                borderRadius: "8px",
                border: "1px solid #e5e7eb",
                color: "#9ca3af",
                background: "#f9fafb",
              }}
            >
              Previous
            </span>
          )}

          {hasNextPage ? (
            <Link
              to={nextPageUrl}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "8px 14px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                textDecoration: "none",
                color: "inherit",
                background: "white",
              }}
            >
              Next
            </Link>
          ) : (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "8px 14px",
                borderRadius: "8px",
                border: "1px solid #e5e7eb",
                color: "#9ca3af",
                background: "#f9fafb",
              }}
            >
              Next
            </span>
          )}
        </div>
      </s-section>

      <s-section slot="aside" heading="Collection & Menu Notes">
        <s-paragraph>
          Use this panel as a quick reference when creating collections manually or
          syncing menus.
        </s-paragraph>

        <div style={{ fontSize: "14px", lineHeight: 1.7 }}>
          <div style={{ marginBottom: "12px" }}>
            <strong>Manual collection rules</strong>
          </div>

          <div>
            <strong>1. Collection title:</strong> Use the format <strong>Primary Secondary Tertiary Coilovers</strong>
          </div>

          <div>
            <strong>2. URL handle must match exactly:</strong> The handle must be the exact same handle shown on this page.
          </div>

          <div>
            <strong>3. Use lowercase letters and hyphens only</strong>
          </div>

          <div>
            <strong>4. Replace "&amp;" with "and"</strong>
          </div>

          <div>
            <strong>5. Do not let Shopify auto-generate a different handle</strong>
          </div>

          <div style={{ marginTop: "10px", color: "#b91c1c" }}>
            If the final handle does not match exactly, this app will treat the collection as missing.
          </div>

          <div style={{ marginTop: "10px", color: "#92400e" }}>
            Keep in mind: deleting an attribute combination from this page does <strong>not</strong> delete the Shopify collection.
          </div>

          <div style={{ marginTop: "14px" }}>
            <strong>Created SEO Collections</strong>
            <div>
              Collections created by this app are <strong>not published</strong> automatically.
            </div>
            <div>
              Please open the collection in Shopify Admin, complete your collection data, then add it to your sales channels to publish it.
            </div>
          </div>

          <div style={{ marginTop: "14px" }}>
            <strong>Menus</strong>
            <div>
              Clicking <strong>"Sync Collection Menus"</strong> will automatically create and update all menu groups for you.
            </div>
            <div>
              Please click sync whenever you add new attribute combinations.
            </div>
          </div>

          <div style={{ marginTop: "14px" }}>
            <strong>Example handle</strong>
            <div style={{ fontFamily: "monospace" }}>
              mazda-miata-na-coilovers
            </div>
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

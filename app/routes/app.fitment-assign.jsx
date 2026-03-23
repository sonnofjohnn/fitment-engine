import { useEffect, useMemo, useState } from "react";
import {
  useLoaderData,
  useActionData,
  useNavigation,
  Form,
  Link,
} from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PRODUCTS_QUERY = `#graphql
  query GetProducts(
    $query: String!
    $first: Int
    $after: String
    $last: Int
    $before: String
  ) {
    products(
      sortKey: TITLE
      query: $query
      first: $first
      after: $after
      last: $last
      before: $before
    ) {
      edges {
        cursor
        node {
          id
          title
          handle
          tags
          vehicleMake: metafield(namespace: "custom", key: "vehicle_make") {
            value
          }
          vehicleModel: metafield(namespace: "custom", key: "vehicle_model") {
            value
          }
          vehicleTrim: metafield(namespace: "custom", key: "vehicle_trim") {
            value
          }
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

const SAVE_METAFIELDS_MUTATION = `#graphql
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

function buildPageUrl({
  search,
  tag,
  after,
  before,
  pageSize,
  fitmentStatus,
}) {
  const params = new URLSearchParams();

  if (search) params.set("search", search);
  if (tag) params.set("tag", tag);
  if (pageSize) params.set("pageSize", String(pageSize));
  if (fitmentStatus && fitmentStatus !== "all") {
    params.set("fitmentStatus", fitmentStatus);
  }
  if (after) params.set("after", after);
  if (before) params.set("before", before);

  const query = params.toString();
  return `/app/fitment-assign${query ? `?${query}` : ""}`;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map((v) => String(v).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const search = url.searchParams.get("search")?.trim() || "";
  const tag = url.searchParams.get("tag")?.trim() || "";
  const after = url.searchParams.get("after")?.trim() || "";
  const before = url.searchParams.get("before")?.trim() || "";
  const fitmentStatus = url.searchParams.get("fitmentStatus")?.trim() || "all";

  const pageSizeParam = Number(url.searchParams.get("pageSize") || "25");
  const allowedPageSizes = [25, 50, 100];
  const pageSize = allowedPageSizes.includes(pageSizeParam) ? pageSizeParam : 25;

  let query = "status:active";
  if (search) query += ` AND title:*${search}*`;
  if (tag) query += ` AND tag:${tag}`;

  if (fitmentStatus === "missing") {
    query +=
      " AND (-metafields.custom.vehicle_make:* OR -metafields.custom.vehicle_model:*)";
  }

  const variables = {
    query,
    first: before ? null : pageSize,
    after: before ? null : after || null,
    last: before ? pageSize : null,
    before: before || null,
  };

  const response = await admin.graphql(PRODUCTS_QUERY, { variables });
  const result = await response.json();

  const connection = result?.data?.products;
  const edges = connection?.edges || [];
  const pageInfo = connection?.pageInfo || {};

  const products = edges.map(({ node }) => ({
    id: node.id,
    title: node.title,
    handle: node.handle,
    tags: node.tags || [],
    vehicleMake: node.vehicleMake?.value || "",
    vehicleModel: node.vehicleModel?.value || "",
    vehicleTrim: node.vehicleTrim?.value || "",
  }));

  const fitmentRows = await db.fitmentOption.findMany({
    where: { shop },
    orderBy: [{ make: "asc" }, { model: "asc" }, { trim: "asc" }],
    select: {
      make: true,
      model: true,
      trim: true,
    },
  });

  const makes = uniqueSorted(fitmentRows.map((row) => row.make));

  const modelsByMakeMap = new Map();
  const trimsByMakeModelMap = new Map();

  for (const row of fitmentRows) {
    const make = String(row.make || "").trim();
    const model = String(row.model || "").trim();
    const trim = String(row.trim || "").trim();

    if (make && model) {
      if (!modelsByMakeMap.has(make)) {
        modelsByMakeMap.set(make, new Set());
      }
      modelsByMakeMap.get(make).add(model);
    }

    if (make && model && trim) {
      const key = `${make}|||${model}`;
      if (!trimsByMakeModelMap.has(key)) {
        trimsByMakeModelMap.set(key, new Set());
      }
      trimsByMakeModelMap.get(key).add(trim);
    }
  }

  const modelsByMake = Object.fromEntries(
    [...modelsByMakeMap.entries()].map(([make, set]) => [
      make,
      [...set].sort((a, b) => a.localeCompare(b)),
    ])
  );

  const trimsByMakeModel = Object.fromEntries(
    [...trimsByMakeModelMap.entries()].map(([key, set]) => [
      key,
      [...set].sort((a, b) => a.localeCompare(b)),
    ])
  );

  const nextPageUrl = pageInfo.hasNextPage
    ? buildPageUrl({
        search,
        tag,
        pageSize,
        fitmentStatus,
        after: pageInfo.endCursor,
      })
    : null;

  const previousPageUrl = pageInfo.hasPreviousPage
    ? buildPageUrl({
        search,
        tag,
        pageSize,
        fitmentStatus,
        before: pageInfo.startCursor,
      })
    : null;

  return {
    products,
    search,
    tag,
    pageSize,
    fitmentStatus,
    nextPageUrl,
    previousPageUrl,
    fitmentSuggestions: {
      makes,
      modelsByMake,
      trimsByMakeModel,
    },
  };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType")?.toString();

  if (actionType !== "saveFitment") {
    return {
      success: false,
      message: "Invalid action.",
    };
  }

  const productId = formData.get("productId")?.toString() || "";
  const productTitle = formData.get("productTitle")?.toString() || "";
  const vehicleMake = formData.get("vehicleMake")?.toString().trim() || "";
  const vehicleModel = formData.get("vehicleModel")?.toString().trim() || "";
  const vehicleTrim = formData.get("vehicleTrim")?.toString().trim() || "";

  if (!productId) {
    return {
      success: false,
      message: "Missing product.",
    };
  }

  if (!vehicleMake || !vehicleModel) {
    return {
      success: false,
      message: "Primary and Secondary attributes are required. Tertiary is optional.",
      productId,
    };
  }

  const metafields = [
    {
      ownerId: productId,
      namespace: "custom",
      key: "vehicle_make",
      type: "single_line_text_field",
      value: vehicleMake,
    },
    {
      ownerId: productId,
      namespace: "custom",
      key: "vehicle_model",
      type: "single_line_text_field",
      value: vehicleModel,
    },
  ];

  if (vehicleTrim) {
    metafields.push({
      ownerId: productId,
      namespace: "custom",
      key: "vehicle_trim",
      type: "single_line_text_field",
      value: vehicleTrim,
    });
  }

  const response = await admin.graphql(SAVE_METAFIELDS_MUTATION, {
    variables: { metafields },
  });

  const result = await response.json();
  const saveResult = result?.data?.metafieldsSet;

  if (saveResult?.userErrors?.length > 0) {
    return {
      success: false,
      message: saveResult.userErrors[0].message,
      productId,
    };
  }

  const existingFitment = await db.fitmentOption.findFirst({
    where: {
      shop,
      make: vehicleMake,
      model: vehicleModel,
      trim: vehicleTrim,
    },
  });

  if (!existingFitment) {
    await db.fitmentOption.create({
      data: {
        shop,
        make: vehicleMake,
        model: vehicleModel,
        trim: vehicleTrim,
      },
    });
  }

  return {
    success: true,
    message: `Saved attributes for ${productTitle}: ${vehicleMake} / ${vehicleModel}${
      vehicleTrim ? ` / ${vehicleTrim}` : ""
    }`,
    productId,
  };
}

function ProductTableRow({
  product,
  navigation,
  actionData,
  fitmentSuggestions,
}) {
  const [make, setMake] = useState(product.vehicleMake || "");
  const [model, setModel] = useState(product.vehicleModel || "");
  const [trim, setTrim] = useState(product.vehicleTrim || "");
  const [justSaved, setJustSaved] = useState(false);

  const formId = `fitment-form-${product.id}`;
  const makeListId = `make-list-${product.id}`;
  const modelListId = `model-list-${product.id}`;
  const trimListId = `trim-list-${product.id}`;

  const isSavingThisRow =
    navigation.state === "submitting" &&
    navigation.formData?.get("actionType") === "saveFitment" &&
    navigation.formData?.get("productId") === product.id;

  useEffect(() => {
    if (
      actionData?.success &&
      actionData?.productId === product.id &&
      navigation.state === "idle"
    ) {
      setJustSaved(true);
      const timer = setTimeout(() => setJustSaved(false), 1800);
      return () => clearTimeout(timer);
    }
  }, [actionData, navigation.state, product.id]);

  const currentFitment =
    product.vehicleMake || product.vehicleModel || product.vehicleTrim
      ? `${product.vehicleMake || "-"} / ${product.vehicleModel || "-"}${
          product.vehicleTrim ? ` / ${product.vehicleTrim}` : ""
        }`
      : "None";

  const inputStyle = {
    width: "100%",
    padding: "5px 7px",
    borderRadius: "6px",
    border: "1px solid #cbd5e1",
    fontSize: "13px",
    boxSizing: "border-box",
  };

  const cellStyle = {
    padding: "8px 8px",
    borderBottom: "1px solid #e5e7eb",
    verticalAlign: "top",
    fontSize: "13px",
  };

  const saveButtonStyle = {
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid #cbd5e1",
    background: justSaved ? "#dcfce7" : "white",
    cursor: isSavingThisRow ? "wait" : "pointer",
    fontSize: "13px",
    fontWeight: 500,
    opacity: isSavingThisRow ? 0.7 : 1,
  };

  const availableModels = useMemo(() => {
    return fitmentSuggestions.modelsByMake[make] || [];
  }, [fitmentSuggestions.modelsByMake, make]);

  const availableTrims = useMemo(() => {
    return fitmentSuggestions.trimsByMakeModel[`${make}|||${model}`] || [];
  }, [fitmentSuggestions.trimsByMakeModel, make, model]);

  const handleMakeChange = (e) => {
    const nextMake = e.target.value;
    setMake(nextMake);

    const nextModels = fitmentSuggestions.modelsByMake[nextMake] || [];
    if (model && !nextModels.includes(model)) {
      setModel("");
      setTrim("");
      return;
    }

    const nextTrims =
      fitmentSuggestions.trimsByMakeModel[`${nextMake}|||${model}`] || [];
    if (trim && !nextTrims.includes(trim)) {
      setTrim("");
    }
  };

  const handleModelChange = (e) => {
    const nextModel = e.target.value;
    setModel(nextModel);

    const nextTrims =
      fitmentSuggestions.trimsByMakeModel[`${make}|||${nextModel}`] || [];
    if (trim && !nextTrims.includes(trim)) {
      setTrim("");
    }
  };

  return (
    <tr
      style={{
        background: justSaved ? "#dcfce7" : "white",
        transition: "background-color 0.35s ease",
      }}
    >
      <td style={{ ...cellStyle, width: "24%" }}>
        <div style={{ fontWeight: "600", lineHeight: 1.3 }}>{product.title}</div>
        <div style={{ color: "#6b7280", fontSize: "12px", marginTop: "2px" }}>
          {product.handle}
        </div>
      </td>

      <td
        style={{
          ...cellStyle,
          width: "16%",
          whiteSpace: "normal",
          wordBreak: "break-word",
        }}
      >
        {currentFitment}
      </td>

      <td style={{ ...cellStyle, width: "16%" }}>
        <Form method="post" id={formId}>
          <input type="hidden" name="actionType" value="saveFitment" />
          <input type="hidden" name="productId" value={product.id} />
          <input type="hidden" name="productTitle" value={product.title} />
          <input type="hidden" name="vehicleMake" value={make} />
          <input type="hidden" name="vehicleModel" value={model} />
          <input type="hidden" name="vehicleTrim" value={trim} />
        </Form>

        <input
          value={make}
          onChange={handleMakeChange}
          placeholder="Primary"
          style={inputStyle}
          list={makeListId}
        />
        <datalist id={makeListId}>
          {fitmentSuggestions.makes.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </td>

      <td style={{ ...cellStyle, width: "16%" }}>
        <input
          value={model}
          onChange={handleModelChange}
          placeholder="Secondary"
          style={inputStyle}
          list={modelListId}
        />
        <datalist id={modelListId}>
          {availableModels.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </td>

      <td style={{ ...cellStyle, width: "16%" }}>
        <input
          value={trim}
          onChange={(e) => setTrim(e.target.value)}
          placeholder="Optional"
          style={inputStyle}
          list={trimListId}
        />
        <datalist id={trimListId}>
          {availableTrims.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </td>

      <td style={{ ...cellStyle, width: "12%" }}>
        <button
          type="submit"
          form={formId}
          disabled={isSavingThisRow}
          style={saveButtonStyle}
        >
          {isSavingThisRow ? "Saving..." : justSaved ? "Saved" : "Save"}
        </button>
      </td>
    </tr>
  );
}

export default function FitmentAssignPage() {
  const {
    products,
    search,
    tag,
    nextPageUrl,
    previousPageUrl,
    pageSize,
    fitmentStatus,
    fitmentSuggestions,
  } = useLoaderData();

  const actionData = useActionData();
  const navigation = useNavigation();

  return (
    <s-page heading="Attribute Assignment" fullWidth>
      <div style={{ padding: "16px" }}>
        <div
          style={{
            marginBottom: "20px",
            background: "white",
            border: "1px solid #e5e7eb",
            borderRadius: "10px",
            padding: "16px",
          }}
        >
          <div style={{ fontWeight: "600", fontSize: "18px", marginBottom: "8px" }}>
            Search and assign product attributes
          </div>

          <div
            style={{
              marginBottom: "16px",
              padding: "12px",
              borderRadius: "8px",
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              fontSize: "14px",
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: "6px" }}>
              How to use this page
            </div>

            <div>
              • Search products or filter by tag, then assign attributes directly in the table.
            </div>

            <div>
              • <strong>Primary and Secondary attributes are required.</strong> Tertiary is optional.
            </div>

            <div>
              • Fields support autosuggest dropdowns based on your saved attribute data.
            </div>

            <div>
              • Use <strong>Attribute status</strong> to quickly find products missing required data.
            </div>

            <div>
              • Click <strong>Save</strong> to apply attributes to the product.
            </div>

            <div style={{ marginTop: "8px", color: "#065f46" }}>
              ✓ Any combination you assign and save here will automatically be added to your Attribute Data.
            </div>

            <div style={{ marginTop: "6px", color: "#92400e" }}>
              This keeps your attribute system synced without needing to manually add combinations.
            </div>
          </div>

          <Form method="get">
            <div
              style={{
                display: "grid",
                gap: "12px",
                gridTemplateColumns: "2fr 1fr 180px 140px",
                marginBottom: "16px",
              }}
            >
              <label>
                <div style={{ marginBottom: "4px" }}>Search product title</div>
                <input
                  name="search"
                  defaultValue={search}
                  placeholder="Product Title.."
                  style={{
                    width: "100%",
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    boxSizing: "border-box",
                  }}
                />
              </label>

              <label>
                <div style={{ marginBottom: "4px" }}>Filter by tag</div>
                <input
                  name="tag"
                  defaultValue={tag}
                  placeholder="Shopify Tags"
                  style={{
                    width: "100%",
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    boxSizing: "border-box",
                  }}
                />
              </label>

              <label>
                <div style={{ marginBottom: "4px" }}>Attribute status</div>
                <select
                  name="fitmentStatus"
                  defaultValue={fitmentStatus}
                  style={{
                    width: "100%",
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    boxSizing: "border-box",
                    background: "white",
                  }}
                >
                  <option value="all">All products</option>
                  <option value="missing">Missing required attributes</option>
                </select>
              </label>

              <label>
                <div style={{ marginBottom: "4px" }}>Page size</div>
                <select
                  name="pageSize"
                  defaultValue={String(pageSize)}
                  style={{
                    width: "100%",
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    boxSizing: "border-box",
                    background: "white",
                  }}
                >
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
              </label>
            </div>

            <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
              <s-button type="submit">Apply Filters</s-button>
              <Link
                to="/app/fitment-assign"
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
                Clear
              </Link>
            </div>
          </Form>

          {actionData?.message ? (
            <div
              style={{
                marginBottom: "16px",
                padding: "12px",
                borderRadius: "8px",
                background: actionData.success ? "#d1fae5" : "#fee2e2",
                border: "1px solid",
                borderColor: actionData.success ? "#10b981" : "#ef4444",
                fontWeight: "500",
              }}
            >
              {actionData.success ? "✓ " : "⚠ "} {actionData.message}
            </div>
          ) : null}
        </div>

        <div
          style={{
            marginBottom: "12px",
            fontSize: "13px",
            color: "#6b7280",
          }}
        >
          Showing up to {pageSize} products per page.
          {fitmentStatus === "missing" ? " Filter: Missing required attributes." : ""}
        </div>

        {products.length === 0 ? (
          <div
            style={{
              background: "white",
              border: "1px solid #e5e7eb",
              borderRadius: "10px",
              padding: "16px",
            }}
          >
            No matching products found.
          </div>
        ) : (
          <div
            style={{
              width: "100%",
              background: "white",
              border: "1px solid #e5e7eb",
              borderRadius: "10px",
              overflow: "hidden",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                tableLayout: "fixed",
              }}
            >
              <thead>
                <tr style={{ background: "#f9fafb" }}>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "10px 8px",
                      borderBottom: "1px solid #e5e7eb",
                      fontSize: "13px",
                      width: "24%",
                    }}
                  >
                    Product
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "10px 8px",
                      borderBottom: "1px solid #e5e7eb",
                      fontSize: "13px",
                      width: "16%",
                    }}
                  >
                    Current Attributes
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "10px 8px",
                      borderBottom: "1px solid #e5e7eb",
                      fontSize: "13px",
                      width: "16%",
                    }}
                  >
                    Primary Attribute
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "10px 8px",
                      borderBottom: "1px solid #e5e7eb",
                      fontSize: "13px",
                      width: "16%",
                    }}
                  >
                    Secondary Attribute
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "10px 8px",
                      borderBottom: "1px solid #e5e7eb",
                      fontSize: "13px",
                      width: "16%",
                    }}
                  >
                    Tertiary Attribute
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "10px 8px",
                      borderBottom: "1px solid #e5e7eb",
                      fontSize: "13px",
                      width: "12%",
                    }}
                  >
                    Action
                  </th>
                </tr>
              </thead>

              <tbody>
                {products.map((product) => (
                  <ProductTableRow
                    key={product.id}
                    product={product}
                    navigation={navigation}
                    actionData={actionData}
                    fitmentSuggestions={fitmentSuggestions}
                  />
                ))}
              </tbody>
            </table>
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
          {previousPageUrl ? (
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

          {nextPageUrl ? (
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
      </div>
    </s-page>
  );
}
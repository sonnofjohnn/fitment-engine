import { useActionData, useNavigation, Form } from "react-router";
import { authenticate } from "../shopify.server";

const CREATE_METAFIELD_MUTATION = `
  mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        name
        namespace
        key
        ownerType
        capabilities {
          smartCollectionCondition {
            enabled
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const UPDATE_METAFIELD_MUTATION = `
  mutation UpdateMetafieldDefinition($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition {
        id
        name
        namespace
        key
        ownerType
        capabilities {
          smartCollectionCondition {
            enabled
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const GET_METAFIELD_DEFINITION_QUERY = `
  query GetMetafieldDefinition($ownerType: MetafieldOwnerType!, $namespace: String!, $key: String!) {
    metafieldDefinitions(
      first: 1
      ownerType: $ownerType
      namespace: $namespace
      key: $key
    ) {
      nodes {
        id
        name
        namespace
        key
        ownerType
        capabilities {
          smartCollectionCondition {
            enabled
          }
        }
      }
    }
  }
`;

const metafieldMap = {
  make: {
    name: "Primary Attribute",
    namespace: "custom",
    key: "vehicle_make",
    description: "Primary attribute used for SEO collection grouping",
  },
  model: {
    name: "Secondary Attribute",
    namespace: "custom",
    key: "vehicle_model",
    description: "Secondary attribute used for SEO collection grouping",
  },
  trim: {
    name: "Tertiary Attribute",
    namespace: "custom",
    key: "vehicle_trim",
    description: "Optional tertiary attribute for deeper grouping",
  },
};

async function getExistingDefinition(admin, selected) {
  const response = await admin.graphql(GET_METAFIELD_DEFINITION_QUERY, {
    variables: {
      ownerType: "PRODUCT",
      namespace: selected.namespace,
      key: selected.key,
    },
  });

  const result = await response.json();
  return result?.data?.metafieldDefinitions?.nodes?.[0] || null;
}

async function updateDefinitionForSmartCollections(admin, selected) {
  const response = await admin.graphql(UPDATE_METAFIELD_MUTATION, {
    variables: {
      definition: {
        ownerType: "PRODUCT",
        namespace: selected.namespace,
        key: selected.key,
        name: selected.name,
        capabilities: {
          adminFilterable: {
            enabled: true,
          },
          smartCollectionCondition: {
            enabled: true,
          },
        },
      },
    },
  });

  const result = await response.json();
  return result?.data?.metafieldDefinitionUpdate;
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const metafieldType = formData.get("metafieldType");

  const selected = metafieldMap[metafieldType];

  if (!selected) {
    return {
      success: false,
      message: "Invalid attribute type.",
    };
  }

  try {
    const createResponse = await admin.graphql(CREATE_METAFIELD_MUTATION, {
      variables: {
        definition: {
          name: selected.name,
          namespace: selected.namespace,
          key: selected.key,
          description: selected.description,
          ownerType: "PRODUCT",
          type: "single_line_text_field",
          capabilities: {
            smartCollectionCondition: {
              enabled: true,
            },
          },
        },
      },
    });

    const createJson = await createResponse.json();
    const createResult = createJson?.data?.metafieldDefinitionCreate;
    const createErrors = createResult?.userErrors || [];

    if (createErrors.length === 0) {
      return {
        success: true,
        message: `${selected.name} created successfully and is ready for SEO collections.`,
      };
    }

    const existingDefinition = await getExistingDefinition(admin, selected);

    if (!existingDefinition) {
      return {
        success: false,
        message: `${selected.name} already exists but could not be updated.`,
      };
    }

    const updateResult = await updateDefinitionForSmartCollections(admin, selected);

    const updateErrors = updateResult?.userErrors || [];

    if (updateErrors.length > 0) {
      return {
        success: false,
        message: updateErrors[0]?.message || "Failed to update attribute.",
      };
    }

    return {
      success: true,
      message: `${selected.name} updated and ready for smart collections.`,
    };
  } catch (error) {
    return {
      success: false,
      message: error?.message || "Something went wrong.",
    };
  }
}

export default function AttributeSetup() {
  const data = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Attribute Setup">
      <s-section>
        <s-stack direction="block" gap="loose">
          <s-box padding="large" border="base" border-radius="large" background="subdued">
            <s-stack direction="block" gap="tight">
              <s-heading>Set up product attributes</s-heading>
              <s-paragraph>
                These attributes power your SEO collections. They allow products to be grouped
                dynamically and used in smart collection rules.
              </s-paragraph>
              <s-paragraph>
                You only need to run each one once. If an attribute already exists, it will be updated
                automatically.
              </s-paragraph>
            </s-stack>
          </s-box>

          <s-grid columns="3" gap="base">
            <s-box padding="large" border="base" border-radius="large">
              <s-heading size="small">Primary Attribute</s-heading>
              <s-paragraph>Creates <s-text>custom.vehicle_make</s-text></s-paragraph>
              <Form method="post">
                <input type="hidden" name="metafieldType" value="make" />
                <s-button type="submit" {...(isSubmitting ? { loading: true } : {})}>
                  Create Primary Attribute
                </s-button>
              </Form>
            </s-box>

            <s-box padding="large" border="base" border-radius="large">
              <s-heading size="small">Secondary Attribute</s-heading>
              <s-paragraph>Creates <s-text>custom.vehicle_model</s-text></s-paragraph>
              <Form method="post">
                <input type="hidden" name="metafieldType" value="model" />
                <s-button type="submit" {...(isSubmitting ? { loading: true } : {})}>
                  Create Secondary Attribute
                </s-button>
              </Form>
            </s-box>

            <s-box padding="large" border="base" border-radius="large">
              <s-heading size="small">Tertiary Attribute</s-heading>
              <s-paragraph>Creates <s-text>custom.vehicle_trim</s-text></s-paragraph>
              <Form method="post">
                <input type="hidden" name="metafieldType" value="trim" />
                <s-button type="submit" {...(isSubmitting ? { loading: true } : {})}>
                  Create Tertiary Attribute
                </s-button>
              </Form>
            </s-box>
          </s-grid>

          {data?.message && (
            <div style={{
              padding: "12px",
              borderRadius: "8px",
              background: data.success ? "#dcfce7" : "#fee2e2",
              border: `1px solid ${data.success ? "#22c55e" : "#ef4444"}`
            }}>
              {data.success ? "✓ " : "⚠ "} {data.message}
            </div>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
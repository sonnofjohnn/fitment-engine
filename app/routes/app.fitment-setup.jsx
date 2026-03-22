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
    name: "Vehicle Make",
    namespace: "custom",
    key: "vehicle_make",
    description: "Vehicle make for fitment filtering",
  },
  model: {
    name: "Vehicle Model",
    namespace: "custom",
    key: "vehicle_model",
    description: "Vehicle model for fitment filtering",
  },
  trim: {
    name: "Vehicle Trim",
    namespace: "custom",
    key: "vehicle_trim",
    description: "Vehicle trim for fitment filtering",
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
}
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
      message: "Invalid metafield type.",
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
      const enabled =
        createResult?.createdDefinition?.capabilities?.smartCollectionCondition
          ?.enabled;

      return {
        success: true,
        message: enabled
          ? `${selected.name} created successfully with smart collections enabled.`
          : `${selected.name} created successfully, but smart collection capability could not be confirmed.`,
      };
    }

    const firstError = createErrors[0];
    const firstMessage = firstError?.message || "Unknown error.";

    const alreadyExists =
      firstMessage.includes("Key is in use") ||
      firstMessage.includes("already exists");

    if (!alreadyExists) {
      return {
        success: false,
        message: firstMessage,
      };
    }

    const existingDefinition = await getExistingDefinition(admin, selected);

    if (!existingDefinition) {
      return {
        success: false,
        message: `${selected.name} already exists, but the existing definition could not be found for update.`,
      };
    }

    if (
      existingDefinition?.capabilities?.smartCollectionCondition?.enabled ===
      true
    ) {
      return {
        success: true,
        message: `${selected.name} already exists and smart collections are already enabled.`,
      };
    }

    const updateResult = await updateDefinitionForSmartCollections(
      admin,
      selected
    );

    const updateErrors = updateResult?.userErrors || [];

    if (updateErrors.length > 0) {
      return {
        success: false,
        message: updateErrors[0]?.message || "Failed to update metafield definition.",
      };
    }

    const enabled =
      updateResult?.updatedDefinition?.capabilities?.smartCollectionCondition
        ?.enabled;

    return {
      success: enabled,
      message: enabled
        ? `${selected.name} already existed and was updated to support smart collections.`
        : `${selected.name} already existed, but smart collection capability could not be confirmed after update.`,
    };
  } catch (error) {
    return {
      success: false,
      message:
        error?.message || "Something went wrong while creating the metafield definition.",
    };
  }
}

export default function FitmentSetup() {
  const data = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Fitment Setup">
      <s-section>
        <s-stack direction="block" gap="loose">
          <s-box
            padding="large"
            border="base"
            border-radius="large"
            background="subdued"
          >
            <s-stack direction="block" gap="tight">
              <s-heading>Create product metafields</s-heading>
              <s-paragraph>
                These buttons create the required product metafield definitions
                for vehicle fitment and enable them for smart collection rules.
              </s-paragraph>
              <s-paragraph>
                You only need to run each one once. If a metafield already
                exists, this page will update it so smart collections are
                enabled.
              </s-paragraph>
            </s-stack>
          </s-box>

          <s-grid columns="3" gap="base">
            <s-box
              padding="large"
              border="base"
              border-radius="large"
              background="default"
            >
              <s-stack direction="block" gap="base">
                <s-heading size="small">Vehicle Make</s-heading>
                <s-paragraph>
                  Creates <s-text>custom.vehicle_make</s-text> and enables it
                  for smart collections.
                </s-paragraph>

                <Form method="post">
                  <input type="hidden" name="metafieldType" value="make" />
                  <s-button
                    type="submit"
                    {...(isSubmitting ? { loading: true } : {})}
                  >
                    Create Vehicle Make
                  </s-button>
                </Form>
              </s-stack>
            </s-box>

            <s-box
              padding="large"
              border="base"
              border-radius="large"
              background="default"
            >
              <s-stack direction="block" gap="base">
                <s-heading size="small">Vehicle Model</s-heading>
                <s-paragraph>
                  Creates <s-text>custom.vehicle_model</s-text> and enables it
                  for smart collections.
                </s-paragraph>

                <Form method="post">
                  <input type="hidden" name="metafieldType" value="model" />
                  <s-button
                    type="submit"
                    {...(isSubmitting ? { loading: true } : {})}
                  >
                    Create Vehicle Model
                  </s-button>
                </Form>
              </s-stack>
            </s-box>

            <s-box
              padding="large"
              border="base"
              border-radius="large"
              background="default"
            >
              <s-stack direction="block" gap="base">
                <s-heading size="small">Vehicle Trim</s-heading>
                <s-paragraph>
                  Creates <s-text>custom.vehicle_trim</s-text> and enables it
                  for smart collections.
                </s-paragraph>

                <Form method="post">
                  <input type="hidden" name="metafieldType" value="trim" />
                  <s-button
                    type="submit"
                    {...(isSubmitting ? { loading: true } : {})}
                  >
                    Create Vehicle Trim
                  </s-button>
                </Form>
              </s-stack>
            </s-box>
          </s-grid>

          {data?.message ? (
            <div
              style={{
                marginTop: "8px",
                padding: "14px 16px",
                borderRadius: "10px",
                background: data.success ? "#dcfce7" : "#fee2e2",
                border: `1px solid ${data.success ? "#22c55e" : "#ef4444"}`,
                fontWeight: 500,
              }}
            >
              {data.success ? "✓ " : "⚠ "} {data.message}
            </div>
          ) : null}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Metafields created">
        <s-stack direction="block" gap="base">
          <s-box
            padding="base"
            border="base"
            border-radius="large"
            background="default"
          >
            <s-paragraph>custom.vehicle_make</s-paragraph>
            <s-paragraph>custom.vehicle_model</s-paragraph>
            <s-paragraph>custom.vehicle_trim</s-paragraph>
          </s-box>

          <s-box
            padding="base"
            border="base"
            border-radius="large"
            background="subdued"
          >
            <s-paragraph>
              These definitions are created on <s-text>PRODUCT</s-text> and are
              configured for smart collection conditions.
            </s-paragraph>
          </s-box>
        </s-stack>
      </s-section>
    </s-page>
  );
}
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { Pagination } from "@shopify/polaris";

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const direction = url.searchParams.get("direction");

    let queryVariables = {
        first: 10,
    };

    if (cursor) {
        if (direction === "previous") {
            queryVariables = {
                last: 10,
                before: cursor,
            };
        } else {
            queryVariables = {
                first: 10,
                after: cursor,
            };
        }
    }

    const response = await admin.graphql(
        `#graphql
    query getProducts($first: Int, $last: Int, $after: String, $before: String) {
      productsCount {
        count
      }
      products(first: $first, last: $last, after: $after, before: $before) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            status
            totalInventory
            featuredImage {
              url
              altText
            }
            variants(first: 1) {
              edges {
                node {
                  price
                }
              }
            }
          }
        }
      }
    }`,
        { variables: queryVariables }
    );

    const responseJson = await response.json();

    return {
        products: responseJson.data.products.edges.map((edge) => edge.node),
        pageInfo: responseJson.data.products.pageInfo,
        totalCount: responseJson.data.productsCount?.count || 0,
    };
};

export default function ProductsPage() {
    const { products, pageInfo, totalCount } = useLoaderData();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();

    const currentPage = parseInt(searchParams.get("page") || "1", 10);

    const handlePagination = (direction, cursor) => {
        const params = new URLSearchParams(searchParams);
        params.set("direction", direction);
        params.set("cursor", cursor);

        const newPage = direction === "next" ? currentPage + 1 : Math.max(1, currentPage - 1);
        params.set("page", newPage);

        navigate(`?${params.toString()}`);
    };

    const startItem = (currentPage - 1) * 10 + 1;
    const endItem = Math.min(startItem + products.length - 1, totalCount);
    const paginationLabel = totalCount > 0 ? `${startItem}-${endItem} of ${totalCount} products` : "No products";

    if (products.length === 0) {
        return (
            <s-page heading="Products">
                <s-empty-state
                    heading="No products found"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                    <s-paragraph>Add products to your store to see them here.</s-paragraph>
                    <s-button
                        slot="action"
                        href="shopify://admin/products/new"
                        target="_blank"
                    >
                        Add product
                    </s-button>
                </s-empty-state>
            </s-page>
        );
    }

    return (
        <s-page heading="Get Products" className="products-page">
            <s-box paddingBlockStart="large" paddingBlockEnd="large">
                <s-section padding="none">
                    <s-table className="products-table">
                        <s-table-header-row>
                            <s-table-header>Image</s-table-header>
                            <s-table-header>Title</s-table-header>
                            <s-table-header>Status</s-table-header>
                            <s-table-header format="numeric">Inventory</s-table-header>
                            <s-table-header format="numeric">Price</s-table-header>
                        </s-table-header-row>
                        <s-table-body>
                            {products.map((product) => (
                                <s-table-row key={product.id}>
                                    <s-table-cell>
                                        <img
                                            src={product.featuredImage?.url || "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png"}
                                            alt={product.featuredImage?.altText || product.title}
                                            style={{
                                                width: "50px",
                                                height: "50px",
                                                objectFit: "cover",
                                                borderRadius: "8px",
                                                border: "1px solid #e1e3e5",
                                                backgroundColor: "#f6f6f7"
                                            }}
                                        />
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-text fontWeight="semibold">{product.title}</s-text>
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-badge tone={product.status === "ACTIVE" ? "success" : "info"}>
                                            {product.status}
                                        </s-badge>
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-text tone="subdued">{product.totalInventory} in stock</s-text>
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-text fontWeight="semibold">
                                            ${product.variants.edges[0]?.node.price}
                                        </s-text>
                                    </s-table-cell>
                                </s-table-row>
                            ))}
                        </s-table-body>
                    </s-table>
                    <div className="table-pagination">
                        <Pagination
                            hasPrevious={pageInfo.hasPreviousPage}
                            onPrevious={() => handlePagination("previous", pageInfo.startCursor)}
                            hasNext={pageInfo.hasNextPage}
                            onNext={() => handlePagination("next", pageInfo.endCursor)}
                            type="table"
                            label={paginationLabel}
                        />
                    </div>
                </s-section>
            </s-box>
        </s-page>
    );
}

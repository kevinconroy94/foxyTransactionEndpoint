import { createRequire } from "module";
const require = createRequire(import.meta.url);

const axios = require('axios');
require('dotenv').config();
const nodemailer = require('nodemailer');

export const handler = async (event, context) => {


    // nodemailer for error handling
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', // replace with your SMTP host
        port: 465, // use 465 for secure connections
        secure: true, // true for 465, false for other ports
        auth: {
        user: process.env.GMAIL_EMAIL, // your email
        pass: process.env.GMAIL_PASS // your email password
        }
    });
    

    console.log('IN TRANSACTION ENDPOINT FUNCTION')
  
    let transactionData = JSON.parse(event.body);
    console.log(transactionData);
    console.log(transactionData['_embedded']['fx:items']);

    // variables for TEST Acc. Pipeline and Stage = Acc Ordering
    let testDealStage = "187417416";
    let testPipeline = "103054498"

    // create plain_text_line_items property for redundancy
    // will include items ordered and email of customer in case a contact is not found
    let plainTextLineItems = "";
    let lineItemsArr = [];

    transactionData['_embedded']['fx:items'].forEach(item => {
        plainTextLineItems += item.quantity + 'x ' + item.name + '\n';
        lineItemsArr.push({
            "name": item.name,
            "quantity": item.quantity,
            "price": item.price,
            "hs_sku": item.code
        });
    }); 

    plainTextLineItems += '\nContact Info:\n' + 
                            transactionData.customer_first_name + 
                            ' ' + transactionData.customer_last_name + '\n' +
                            transactionData.customer_email;

    console.log(plainTextLineItems);

    // Transaction will always come through as PayPal for now
    let paymentTransactionId = transactionData['_embedded']['fx:payments'][0].processor_response;
    
    // Create Shipping address, will be Tune address if items are picked up
    let shipAddTemp =  transactionData['_embedded']['fx:shipments'][0];
    let shippingAddress = shipAddTemp.address1 + '\n' + shipAddTemp.address2 + '\n' + shipAddTemp.city + '\n' + shipAddTemp.region + '\n' + shipAddTemp.postal_code + '\n' + shipAddTemp.country;
    
    // Pick up at warehouse or shipping
    let deliveryMethod = transactionData['_embedded']['fx:shipments'][0].shipping_service_description;

    let orderNotes = "";
    transactionData['_embedded']['fx:custom_fields'].forEach(field => {
        if (field.name === 'Order_Notes') {
            orderNotes = field.value;
        }
    });
    

    const dealUrl = 'https://api.hubapi.com/crm/v3/objects/deals';
    const contactUrl = 'https://api.hubapi.com/crm/v3/objects/contacts';
    const lineItemURL = 'https://api.hubapi.com/crm/v3/objects/line_items';

    const createDealData = {
        "properties": {
            "dealname": transactionData.customer_first_name + ' ' + transactionData.customer_last_name + ' | ' + '$' + transactionData.total_order + ' | ' + transactionData.id,
            "amount": transactionData.total_order,
            "dealstage": testDealStage,
            "pipeline": testPipeline,
            "plain_text_line_items": plainTextLineItems,
            "pp_transaction_id": paymentTransactionId,
            "shipping_address": shippingAddress,
            "shipping_method": deliveryMethod,
            "webflow_order_id": transactionData.id,
            "customer_notes": orderNotes
        }
    };

    // AUTH for Axios
    const token = process.env.TOKEN;
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    axios.defaults.headers.common['Content-Type'] = 'application/json';


    // Start function chain to create deal, line items, contact, and associations
    await createNewDeal();

    // Create new Deal in Accessories Pipeline
    async function createNewDeal() {

        await axios.post(dealUrl, createDealData)
            .then(async response => {
                console.log('Response:', response.data);
                await getOrCreateContact(response.data);
                await associateLineItemsToDeal(response.data);
            })
            .catch(error => {
                console.error('Error:', error);
                const mailOptions = {
                    from: "kevinconroy1994@gmail.com",
                    to: "kevinconroy1994@gmail.com",
                    subject: "Create New Deal Error Notification",
                    text: `An error occurred: ${error.message + ' \n\n' + 'This Deal may have an error:\n' + createDealData['properties']['dealname'] }`,
                };
                
                transporter.sendMail(mailOptions, (err, info) => {
                    if (err) {
                        console.error("Error sending Deal email:", err);
                    } else {
                        console.log("Email sent:", info.response);
                    }
                });
            });

    }

    async function associateLineItemsToDeal(dealObj) {
        lineItemsArr.forEach(async item => {
            let lineItemData = {
                "properties": {
                    "price": item.price,
                    "quantity": item.quantity,
                    "name": item.name,
                    "hs_sku": item.hs_sku
                },
                "associations": [
                    {
                        "to": {
                            "id": dealObj.id
                        },
                        "types": [
                            {
                                "associationCategory": "HUBSPOT_DEFINED",
                                "associationTypeId": 20
                            }
                        ]
                    } 
                ]
            }
            
            await axios.post(lineItemURL, lineItemData)
                .then(response => {
                    console.log('Line Items Res: ' + response.data);
                })
                .catch(error => {
                    console.error('Line Item Association Error:', error);
                    // send email
                    const mailOptions = {
                        from: "kevinconroy1994@gmail.com",
                        to: "kevinconroy1994@gmail.com",
                        subject: "Associate Line Item Error Notification",
                        text: `An error occurred: ${error.message + ' \n\n' + 'Line Item Assocation problems with\n' + dealObj.properties.dealname + '\n' + item.name + ' ' + item.quantitys}`,
                    };
                    
                    transporter.sendMail(mailOptions, (err, info) => {
                        if (err) {
                            console.error("Error Contact sending email:", err);
                        } else {
                            console.log("Email sent:", info.response);
                        }
                    });   
                });
        });
    }


    async function getOrCreateContact(dealObj) {
        
        // Check if the contact already exists
        await axios.get(contactUrl + `/${ transactionData.customer_email }?idProperty=email`)
            .then(async response => {
                console.log('HS CONTACT OBJECT: ' + response.data.id + response.data.properties.email);
                await associateContactToDeal(dealObj, response.data);
            })
            .catch(async error => {
                console.error('Error:', error);
                console.log('Creating new contact');

                // If a contact is not returned, a new one is created and associated with the Deal
                const createContactData = {
                    "properties": {
                        "email": transactionData.customer_email,
                        "firstname": transactionData.customer_first_name,
                        "lastname": transactionData.customer_last_name
                    },
                    "associations": [
                        {
                            "to": {
                                "id": dealObj.id
                            },
                            "types": [
                                {
                                "associationCategory": "HUBSPOT_DEFINED",
                                "associationTypeId": 4
                                }
                            ]
                        }
                    ]
                }
                await axios.post(contactUrl, createContactData)
                    .then(response => {
                        console.log(response.data);
                    })
                    .catch(error => {
                        console.error('Error: ', error);
                        console.log('New Contact was not created/not associated to the Deal for: ' + createDealData['properties']['dealname'])

                        // send email
                        const mailOptions = {
                            from: "kevinconroy1994@gmail.com",
                            to: "kevinconroy1994@gmail.com",
                            subject: "Create New Contact Error Notification",
                            text: `An error occurred: ${error.message + ' \n\n' + 'Contact was not created for:\n' + createDealData['properties']['dealname'] + '\n' + transactionData.customer_email}`,
                        };
                        
                        transporter.sendMail(mailOptions, (err, info) => {
                            if (err) {
                                console.error("Error Contact sending email:", err);
                            } else {
                                console.log("Email sent:", info.response);
                            }
                        });
                    });
            });
    
    }

    async function associateContactToDeal(dealObj, contactObj) {
        let associationUrl = `https://api.hubapi.com/crm/v4/objects/0-1/${ contactObj.id }/associations/0-3/${ dealObj.id }`;
        let associationData = [
            {
                "associationCategory": "HUBSPOT_DEFINED",
                "associationTypeId": 4
            }
        ]
    
        await axios.put(associationUrl, associationData)
            .then(response => {
                console.log('Association Block');
                console.log(response.data);
            })
            .catch(error => {
                console.error('Error: ' + error);
            });
    
    }
  
    context.callbackWaitsForEmptyEventLoop = false;
  
    console.log("Finishing Transaction Endpoint");
    let results = {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": "{'Test': 'Deal Created'}"
        }
    return results;
};